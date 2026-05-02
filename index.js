import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// CORS setup
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());

const EVENTOFFICE_API_KEY = process.env.EVENTOFFICE_API_KEY;
const BASE_URL = 'https://rental.software/api6';

// Store active connections
const connections = new Map();

// SSE endpoint
app.get('/sse', (req, res) => {
  console.log('New SSE connection established');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');

  const connectionId = Date.now().toString();
  connections.set(connectionId, res);

  const initEvent = {
    jsonrpc: '2.0',
    method: 'connected',
    params: {
      connectionId: connectionId,
      serverInfo: {
        name: 'eventoffice-mcp-server',
        version: '1.0.0'
      }
    }
  };
  
  res.write(`data: ${JSON.stringify(initEvent)}\n\n`);

  const keepAliveInterval = setInterval(() => {
    res.write('event: ping\ndata: {}\n\n');
  }, 30000);

  req.on('close', () => {
    console.log('SSE connection closed');
    clearInterval(keepAliveInterval);
    connections.delete(connectionId);
    res.end();
  });
});

// RPC endpoint
app.post('/rpc', async (req, res) => {
  try {
    const { jsonrpc, id, method, params } = req.body;
    console.log('Received RPC request:', { method, params });

    if (id === undefined || id === null) {
      return res.json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: 'Invalid Request: missing id'
        }
      });
    }

    let result;

    if (method === 'initialize') {
      result = {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'eventoffice-mcp-server',
          version: '1.0.0'
        }
      };
    } else if (method === 'tools/list') {
      result = {
        tools: [
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
        ]
      };
    } else if (method === 'tools/call') {
      result = await handleToolCall(params);
    } else {
      throw new Error(`Unknown method: ${method}`);
    }

    res.json({
      jsonrpc: '2.0',
      id: id,
      result: result
    });

  } catch (error) {
    console.error('RPC Error:', error);
    res.json({
      jsonrpc: '2.0',
      id: req.body?.id ?? null,
      error: {
        code: -32603,
        message: error.message,
        data: error.stack
      }
    });
  }
});

// Tool execution handler
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

  const { name, arguments: args } = params;
  const toolArgs = args || {};

  console.log(`Executing tool: ${name}`, toolArgs);

  try {
    if (name === 'get_leads') {
      const urlParams = new URLSearchParams({ apiKey: EVENTOFFICE_API_KEY });
      
      if (toolArgs.status && toolArgs.status !== 'all') {
        urlParams.append('status', toolArgs.status);
      }
      if (toolArgs.limit) {
        urlParams.append('limit', Math.min(toolArgs.limit, 100));
      }
      
      const response = await axios.get(`${BASE_URL}/leads?${urlParams}`);
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } else if (name === 'create_lead') {
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
          text: `✅ Lead created successfully!\n\nLead ID: ${response.data.id}\nCustomer: ${toolArgs.customer_name}\nEvent Date: ${toolArgs.event_date}`
        }]
      };
    } else if (name === 'get_inventory') {
      const urlParams = new URLSearchParams({ apiKey: EVENTOFFICE_API_KEY });
      
      if (toolArgs.category) urlParams.append('category', toolArgs.category);
      if (toolArgs.search) urlParams.append('search', toolArgs.search);
      
      const response = await axios.get(`${BASE_URL}/rentals?${urlParams}`);
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'EventOffice MCP Server',
    timestamp: new Date().toISOString(),
    connections: connections.size,
    eventoffice_api_configured: !!EVENTOFFICE_API_KEY
  });
});

// Test EventOffice connection
app.get('/test', async (req, res) => {
  try {
    const response = await axios.get(
      `${BASE_URL}/rentals?apiKey=${EVENTOFFICE_API_KEY}&limit=1`
    );
    
    res.json({
      status: 'EventOffice API Connected ✅',
      message: 'Successfully connected to EventOffice',
      sample_data: response.data
    });
  } catch (error) {
    res.status(500).json({
      status: 'EventOffice API Error ❌',
      error: error.message,
      details: error.response?.data
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'EventOffice MCP Server',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      sse: '/sse',
      rpc: '/rpc',
      health: '/health',
      test: '/test'
    }
  });
});

// Start server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log('🚀 EventOffice MCP Server Started');
  console.log('='.repeat(50));
  console.log(`📡 Server URL: http://0.0.0.0:${PORT}`);
  console.log(`🔌 SSE Endpoint: http://0.0.0.0:${PORT}/sse`);
  console.log(`💬 RPC Endpoint: http://0.0.0.0:${PORT}/rpc`);
  console.log(`❤️  Health Check: http://0.0.0.0:${PORT}/health`);
  console.log(`🧪 Test API: http://0.0.0.0:${PORT}/test`);
  console.log('='.repeat(50));
  console.log(`EventOffice API Key: ${EVENTOFFICE_API_KEY ? '✅ Configured' : '❌ Missing'}`);
  console.log('='.repeat(50));
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});