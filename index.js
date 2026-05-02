import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();



app.use(cors({
  origin: ['https://claude.ai', 'https://staging.claude.ai'], 
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-mcp-protocol-version'], // এই হেডারটি যোগ করা হয়েছে
  exposedHeaders: ['x-mcp-protocol-version'] // এটি ক্লডকে প্রোটোকল ভার্সন দেখতে সাহায্য করে
}));

app.use(express.json());

const EVENTOFFICE_API_KEY = process.env.EVENTOFFICE_API_KEY;
const BASE_URL = 'https://rental.software/api6';

// SSE Endpoint
app.get('/sse', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

 app.get('/sse', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // রেলওয়ের বাফারিং বন্ধ করতে এটি মাস্ট
  });

  // ১. প্রথমেই এই বিশেষ ইভেন্টটি পাঠাতে হবে
  res.write(`event: endpoint\ndata: /message\n\n`); 

  // ২. এরপর তোমার ইনট মেসেজ (initMessage) পাঠাও
  const initMessage = {
    jsonrpc: '2.0',
    method: 'initialized',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'eventoffice-mcp-server', version: '1.0.0' }
    }
  };
  res.write(`data: ${JSON.stringify(initMessage)}\n\n`);

  // ৩. হার্টবিট ইন্টারভাল (৩০ সেকেন্ডের বদলে ১৫ সেকেন্ড করো, রেলওয়েতে কানেকশন ড্রপ রোধে)
  const keepAlive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 15000);

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
              description: 'Get leads from EventOffice.',
              inputSchema: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['booked', 'pending', 'cancelled', 'tentative', 'all'] },
                  limit: { type: 'number', default: 20 }
                }
              }
            },
            {
              name: 'create_lead',
              description: 'Create a new lead in EventOffice',
              inputSchema: {
                type: 'object',
                properties: {
                  customer_name: { type: 'string' },
                  email: { type: 'string' },
                  event_date: { type: 'string' }
                },
                required: ['customer_name', 'email', 'event_date']
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

    res.json({ jsonrpc: '2.0', id, result });

  } catch (error) {
    res.json({ jsonrpc: '2.0', id: req.body.id, error: { code: -32603, message: error.message } });
  }
});

// Tool Call Handler (আপনার আগের লজিক ঠিক আছে)
async function handleToolCall(params) {
    const { name, arguments: args } = params;
    try {
        if (name === 'get_leads') {
            const urlParams = new URLSearchParams({ apiKey: EVENTOFFICE_API_KEY });
            const response = await axios.get(`${BASE_URL}/leads?${urlParams}`);
            return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
        }
        // অন্যান্য টুলস...
    } catch (e) { return { content: [{ type: 'text', text: e.message }], isError: true }; }
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
