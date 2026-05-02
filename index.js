import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';

dotenv.config();

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

const EVENTOFFICE_API_KEY = process.env.EVENTOFFICE_API_KEY;
const BASE_URL = 'https://rental.software/api6';
const SERVER_NAME = 'eventoffice-mcp-server';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2024-11-05';

const connections = new Map();

function sendSseEvent(res, event, data) {
  if (event) {
    res.write(`event: ${event}\n`);
  }

  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  res.write(`data: ${payload}\n\n`);
}

function createToolDefinitions() {
  return [
    {
      name: 'get_leads',
      description: 'Get leads/events from EventOffice. Can filter by status (booked, pending, cancelled, tentative).',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Filter by lead status',
            enum: ['booked', 'pending', 'cancelled', 'tentative', 'all']
          },
          limit: {
            type: 'number',
            description: 'Number of results to return',
            default: 20
          }
        }
      }
    },
    {
      name: 'create_lead',
      description: 'Create a new lead/event in EventOffice',
      inputSchema: {
        type: 'object',
        properties: {
          customer_name: { type: 'string', description: 'Customer full name' },
          email: { type: 'string', description: 'Customer email' },
          phone: { type: 'string', description: 'Phone number (optional)' },
          event_date: { type: 'string', description: 'Event date (YYYY-MM-DD)' },
          event_type: { type: 'string', description: 'Type of event' },
          notes: { type: 'string', description: 'Additional notes' }
        },
        required: ['customer_name', 'email', 'event_date']
      }
    },
    {
      name: 'get_inventory',
      description: 'Get rental inventory items from EventOffice',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Filter by category' },
          search: { type: 'string', description: 'Search by name' }
        }
      }
    }
  ];
}

function createJsonRpcError(id, code, message, data) {
  const error = {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code,
      message
    }
  };

  if (data !== undefined) {
    error.error.data = data;
  }

  return error;
}

async function handleRpcMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return createJsonRpcError(null, -32600, 'Invalid Request: body must be a JSON object');
  }

  const { id, method, params } = message;

  if (!method) {
    return createJsonRpcError(id, -32600, 'Invalid Request: missing method');
  }

  const isNotification = id === undefined || id === null;

  if (method === 'notifications/initialized') {
    return null;
  }

  if (method === 'initialize') {
    if (isNotification) {
      return createJsonRpcError(null, -32600, 'Invalid Request: initialize must include an id');
    }

    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION
        }
      }
    };
  }

  if (method === 'tools/list') {
    if (isNotification) {
      return null;
    }

    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: createToolDefinitions()
      }
    };
  }

  if (method === 'tools/call') {
    if (isNotification) {
      return null;
    }

    return {
      jsonrpc: '2.0',
      id,
      result: await handleToolCall(params)
    };
  }

  if (isNotification) {
    return null;
  }

  return createJsonRpcError(id, -32601, `Unknown method: ${method}`);
}

app.get('/sse', (req, res) => {
  console.log('New SSE connection established');

  const sessionId = randomUUID();
  const messageUrl = `${req.protocol}://${req.get('host')}/message?sessionId=${sessionId}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const keepAliveInterval = setInterval(() => {
    sendSseEvent(res, 'ping', {});
  }, 30000);

  connections.set(sessionId, {
    res,
    keepAliveInterval
  });

  sendSseEvent(res, 'endpoint', messageUrl);

  req.on('close', () => {
    console.log('SSE connection closed');
    const session = connections.get(sessionId);
    if (session?.keepAliveInterval) {
      clearInterval(session.keepAliveInterval);
    }
    connections.delete(sessionId);
    res.end();
  });
});

app.post('/rpc', express.json(), async (req, res) => {
  try {
    console.log('Received RPC request:', { method: req.body?.method, params: req.body?.params });

    const response = await handleRpcMessage(req.body);

    if (response === null) {
      return res.sendStatus(204);
    }

    return res.json(response);
  } catch (error) {
    console.error('RPC Error:', error);
    return res.status(500).json(createJsonRpcError(req.body?.id, -32603, error.message, error.stack));
  }
});

app.post('/message', express.text({ type: '*/*' }), async (req, res) => {
  try {
    const sessionId = req.query.sessionId;

    if (!sessionId) {
      return res.status(400).json({ error: 'Missing sessionId query parameter' });
    }

    const session = connections.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Unknown session' });
    }

    const message = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    console.log('Received MCP message:', { method: message?.method, params: message?.params });

    const response = await handleRpcMessage(message);
    if (response !== null) {
      sendSseEvent(session.res, 'message', response);
    }

    return res.sendStatus(202);
  } catch (error) {
    console.error('Message transport error:', error);
    return res.status(400).json({ error: error.message });
  }
});

async function handleToolCall(params) {
  if (!EVENTOFFICE_API_KEY) {
    return {
      content: [{
        type: 'text',
        text: 'Error: EVENTOFFICE_API_KEY is not configured. Please set the environment variable.'
      }],
      isError: true
    };
  }

  const toolParams = params ?? {};
  const { name, arguments: args } = toolParams;
  const toolArgs = args || {};

  console.log(`Executing tool: ${name}`, toolArgs);

  try {
    if (name === 'get_leads') {
      const urlParams = new URLSearchParams({ apiKey: EVENTOFFICE_API_KEY });

      if (toolArgs.status && toolArgs.status !== 'all') {
        urlParams.append('status', toolArgs.status);
      }

      if (toolArgs.limit) {
        urlParams.append('limit', String(Math.min(Number(toolArgs.limit) || 0, 100)));
      }

      const response = await axios.get(`${BASE_URL}/leads?${urlParams.toString()}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    }

    if (name === 'create_lead') {
      if (!toolArgs.customer_name || !toolArgs.email || !toolArgs.event_date) {
        return {
          content: [{
            type: 'text',
            text: 'Error: customer_name, email, and event_date are required.'
          }],
          isError: true
        };
      }

      const leadData = {
        customer: {
          name: toolArgs.customer_name,
          email: toolArgs.email,
          phone: toolArgs.phone || ''
        },
        event_date: toolArgs.event_date,
        event_type: toolArgs.event_type || '',
        notes: toolArgs.notes || '',
        status: 'pending'
      };

      const response = await axios.post(
        `${BASE_URL}/leads?apiKey=${EVENTOFFICE_API_KEY}`,
        leadData
      );

      return {
        content: [{
          type: 'text',
          text: `Lead created successfully!\n\nLead ID: ${response.data.id}\nCustomer: ${toolArgs.customer_name}\nEvent Date: ${toolArgs.event_date}`
        }]
      };
    }

    if (name === 'get_inventory') {
      const urlParams = new URLSearchParams({ apiKey: EVENTOFFICE_API_KEY });

      if (toolArgs.category) {
        urlParams.append('category', toolArgs.category);
      }

      if (toolArgs.search) {
        urlParams.append('search', toolArgs.search);
      }

      const response = await axios.get(`${BASE_URL}/rentals?${urlParams.toString()}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    console.error('Tool execution error:', error.message);

    return {
      content: [{
        type: 'text',
        text: `Error: ${error.response?.data?.message || error.message}`
      }],
      isError: true
    };
  }
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'EventOffice MCP Server',
    timestamp: new Date().toISOString(),
    connections: connections.size,
    eventoffice_api_configured: !!EVENTOFFICE_API_KEY
  });
});

app.get('/test', async (req, res) => {
  try {
    if (!EVENTOFFICE_API_KEY) {
      return res.status(500).json({
        status: 'EventOffice API Error',
        error: 'EVENTOFFICE_API_KEY is not configured'
      });
    }

    const response = await axios.get(
      `${BASE_URL}/rentals?apiKey=${EVENTOFFICE_API_KEY}&limit=1`
    );

    res.json({
      status: 'EventOffice API Connected',
      message: 'Successfully connected to EventOffice',
      sample_data: response.data
    });
  } catch (error) {
    res.status(500).json({
      status: 'EventOffice API Error',
      error: error.message,
      details: error.response?.data
    });
  }
});

app.get('/', (req, res) => {
  res.json({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    status: 'running',
    endpoints: {
      sse: '/sse',
      message: '/message',
      rpc: '/rpc',
      health: '/health',
      test: '/test'
    }
  });
});

const PORT = Number(process.env.PORT) || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log('EventOffice MCP Server Started');
  console.log('='.repeat(50));
  console.log(`Server URL: http://0.0.0.0:${PORT}`);
  console.log(`SSE Endpoint: http://0.0.0.0:${PORT}/sse`);
  console.log(`Message Endpoint: http://0.0.0.0:${PORT}/message`);
  console.log(`RPC Endpoint: http://0.0.0.0:${PORT}/rpc`);
  console.log(`Health Check: http://0.0.0.0:${PORT}/health`);
  console.log(`Test API: http://0.0.0.0:${PORT}/test`);
  console.log('='.repeat(50));
  console.log(`EventOffice API Key: ${EVENTOFFICE_API_KEY ? 'Configured' : 'Missing'}`);
  console.log('='.repeat(50));
});

function shutdown(signal) {
  console.log(`${signal} received, closing server...`);

  for (const [sessionId, session] of connections.entries()) {
    if (session.keepAliveInterval) {
      clearInterval(session.keepAliveInterval);
    }
    session.res.end();
    connections.delete(sessionId);
  }

  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));