import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// CORS - Claude.ai থেকে access করার জন্য
app.use(cors({
  origin: '*', // Production এ specific domain দিবে
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

const EVENTOFFICE_API_KEY = process.env.EVENTOFFICE_API_KEY;
const BASE_URL = 'https://rental.software/api6';

// MCP Server-Sent Events endpoint
app.get('/sse', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Send initialization
  const initMessage = {
    jsonrpc: '2.0',
    method: 'initialized',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: 'eventoffice-mcp-server',
        version: '1.0.0'
      }
    }
  };

  res.write(`data: ${JSON.stringify(initMessage)}\n\n`);

  // Keep connection alive
  const keepAlive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
    res.end();
  });
});

// MCP JSON-RPC endpoint
app.post('/message', async (req, res) => {
  try {
    const { jsonrpc, id, method, params } = req.body;

    console.log('Received request:', { method, params });

    let result;

    switch (method) {
      case 'tools/list':
        result = {
          tools: [
            {
              name: 'get_leads',
              description: 'Get leads from EventOffice. Can filter by status.',
              inputSchema: {
                type: 'object',
                properties: {
                  status: { 
                    type: 'string', 
                    description: 'Filter by status (booked, pending, cancelled, tentative)',
                    enum: ['booked', 'pending', 'cancelled', 'tentative', 'all']
                  },
                  limit: { 
                    type: 'number', 
                    description: 'Number of results (max 100)',
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
                  event_type: { type: 'string', description: 'Event type (wedding, birthday, etc.)' },
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
            },
            {
              name: 'get_customers',
              description: 'Search customers in EventOffice',
              inputSchema: {
                type: 'object',
                properties: {
                  search: { type: 'string', description: 'Search by name/email' },
                  limit: { type: 'number', description: 'Number of results', default: 20 }
                }
              }
            },
            {
              name: 'get_lead_details',
              description: 'Get detailed info about a specific lead',
              inputSchema: {
                type: 'object',
                properties: {
                  lead_id: { type: 'string', description: 'Lead ID' }
                },
                required: ['lead_id']
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
    console.error('Error:', error);
    res.json({
      jsonrpc: '2.0',
      id: req.body.id,
      error: {
        code: -32603,
        message: error.message
      }
    });
  }
});

// Handle tool execution
async function handleToolCall(params) {
  const { name, arguments: args } = params;

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
            text: `✅ Lead created successfully!\n\nLead ID: ${response.data.id || 'N/A'}\nCustomer: ${args.customer_name}\nEvent Date: ${args.event_date}\n\n${JSON.stringify(response.data, null, 2)}`
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

      case 'get_customers': {
        const urlParams = new URLSearchParams({ apiKey: EVENTOFFICE_API_KEY });
        if (args.search) urlParams.append('search', args.search);
        if (args.limit) urlParams.append('limit', args.limit);
        
        const response = await axios.get(`${BASE_URL}/customers?${urlParams}`);
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(response.data, null, 2)
          }]
        };
      }

      case 'get_lead_details': {
        const response = await axios.get(
          `${BASE_URL}/leads/${args.lead_id}?apiKey=${EVENTOFFICE_API_KEY}&_body=true`
        );
        
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
    console.error(`Tool execution error:`, error.message);
    return {
      content: [{
        type: 'text',
        text: `Error: ${error.response?.data?.message || error.message}`
      }],
      isError: true
    };
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'EventOffice MCP Server',
    timestamp: new Date().toISOString()
  });
});

// Test endpoint
app.get('/test', async (req, res) => {
  try {
    const response = await axios.get(
      `${BASE_URL}/rentals?apiKey=${EVENTOFFICE_API_KEY}&limit=1`
    );
    res.json({
      status: 'EventOffice API Connected ✅',
      sample_data: response.data
    });
  } catch (error) {
    res.status(500).json({
      status: 'EventOffice API Error ❌',
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 EventOffice MCP Server running on port ${PORT}`);
  console.log(`📡 SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`💬 Message endpoint: http://localhost:${PORT}/message`);
  console.log(`❤️  Health check: http://localhost:${PORT}/health`);
});