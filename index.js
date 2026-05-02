import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// CORS setup - Claude.ai এর জন্য
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

// SSE endpoint - Claude.ai এখানে connect করবে
app.get('/sse', (req, res) => {
  console.log('New SSE connection established');

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Generate connection ID
  const connectionId = Date.now().toString();
  connections.set(connectionId, res);

  // Send initial connection success
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

  // Keep-alive ping every 30 seconds
  const keepAliveInterval = setInterval(() => {
    res.write(':ping\n\n');
  }, 30000);

  // Clean up on connection close
  req.on('close', () => {
    console.log('SSE connection closed');
    clearInterval(keepAliveInterval);
    connections.delete(connectionId);
    res.end();
  });
});

// Main RPC endpoint - Claude.ai এখানে requests পাঠাবে
app.post('/rpc', async (req, res) => {
  try {
    const { jsonrpc, id, method, params } = req.body;

    console.log('Received RPC request:', { method, params });

    let result;

    switch (method) {
      case 'initialize':
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
        break;

      case 'tools/list':
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
        break;

      case 'tools/call':
        result = await handleToolCall(params);
        break;

      default:
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
      id: req.body.id || null,
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
  const { name, arguments: args = {} } = params;

  console.log(`Executing tool: ${name}`, args);

  try {
    switch (name) {
      case 'get_leads': {
        const urlParams = new URLSearchParams({ apiKey: EVENTOFFICE_API_KEY });
        
        if (args.status && args.status !== 'all') {
          urlParams.append('status', args.status);
        }
        if (args.limit) {
          urlParams.append('limit', Math.min(args.limit, 100));
        }
        
        const response = await axios.get(`${BASE_URL}/leads?${urlParams}`);
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(response.data, null, 2)
          }]
        };
      }

      case 'create_lead': {
        const leadData = {
          customer: {
            name: args.customer_name,
            email: args.email,
            phone: args.phone || ''
          },
          event_date: args.event_date,
          event_type: args.event_type || '',
          notes: args.notes || '',
          status: 'pending'
        };
        
        const response = await axios.post(
          `${BASE_URL}/leads?apiKey=${EVENTOFFICE_API_KEY}`,
          leadData
        );
        
        return {
          content: [{
            type: 'text',
            text: `✅ Lead created successfully!\n\nLead ID: ${response.data.id}\nCustomer: ${args.customer_name}\nEvent Date: ${args.event_date}`
          }]
        };
      }

      case 'get_inventory': {
        const urlParams = new URLSearchParams({ apiKey: EVENTOFFICE_API_KEY });
        
        if (args.category) urlParams.append('category', args.category);
        if (args.search) urlParams.append('search', args.search);
        
        const response = await axios.get(`${BASE_URL}/rentals?${urlParams}`);
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(response.data, null, 2)
          }]
        };
      }

      default:
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