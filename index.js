#!/usr/bin/env node

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';

const API_KEY = process.env.EVENTOFFICE_API_KEY;
const BASE_URL = 'https://rental.software/api6';

if (!API_KEY) {
  console.error('Error: EVENTOFFICE_API_KEY environment variable is required');
  process.exit(1);
}

class EventOfficeServer {
  constructor() {
    this.server = new Server(
      {
        name: 'eventoffice-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  setupToolHandlers() {
    // List all available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_leads',
          description: 'Get leads from EventOffice. You can filter by status (booked, pending, cancelled, etc.)',
          inputSchema: {
            type: 'object',
            properties: {
              status: {
                type: 'string',
                description: 'Filter by lead status (optional)',
                enum: ['booked', 'pending', 'cancelled', 'tentative']
              },
              limit: {
                type: 'number',
                description: 'Number of results to return (default: 10)',
                default: 10
              }
            }
          },
        },
        {
          name: 'create_lead',
          description: 'Create a new lead/event in EventOffice',
          inputSchema: {
            type: 'object',
            properties: {
              customer_name: {
                type: 'string',
                description: 'Customer full name'
              },
              email: {
                type: 'string',
                description: 'Customer email address'
              },
              phone: {
                type: 'string',
                description: 'Customer phone number (optional)'
              },
              event_date: {
                type: 'string',
                description: 'Event date in YYYY-MM-DD format'
              },
              event_type: {
                type: 'string',
                description: 'Type of event (wedding, birthday, corporate, etc.)'
              },
              notes: {
                type: 'string',
                description: 'Additional notes or requirements'
              }
            },
            required: ['customer_name', 'email', 'event_date']
          },
        },
        {
          name: 'get_inventory',
          description: 'Get rental inventory/items from EventOffice',
          inputSchema: {
            type: 'object',
            properties: {
              category: {
                type: 'string',
                description: 'Filter by category name (optional)'
              },
              search: {
                type: 'string',
                description: 'Search by item name (optional)'
              }
            }
          },
        },
        {
          name: 'get_customers',
          description: 'Get customer list from EventOffice',
          inputSchema: {
            type: 'object',
            properties: {
              search: {
                type: 'string',
                description: 'Search by customer name or email'
              },
              limit: {
                type: 'number',
                description: 'Number of results (default: 10)',
                default: 10
              }
            }
          },
        },
        {
          name: 'get_lead_details',
          description: 'Get detailed information about a specific lead by ID',
          inputSchema: {
            type: 'object',
            properties: {
              lead_id: {
                type: 'string',
                description: 'The EventOffice lead ID'
              }
            },
            required: ['lead_id']
          },
        }
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'get_leads':
            return await this.getLeads(args);
          case 'create_lead':
            return await this.createLead(args);
          case 'get_inventory':
            return await this.getInventory(args);
          case 'get_customers':
            return await this.getCustomers(args);
          case 'get_lead_details':
            return await this.getLeadDetails(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`
            }
          ],
          isError: true,
        };
      }
    });
  }

  async getLeads(args) {
    const params = new URLSearchParams({ apiKey: API_KEY });
    if (args.status) params.append('status', args.status);
    if (args.limit) params.append('limit', args.limit);

    const response = await axios.get(`${BASE_URL}/leads?${params}`);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.data, null, 2)
        }
      ],
    };
  }

  async createLead(args) {
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
      `${BASE_URL}/leads?apiKey=${API_KEY}`,
      leadData
    );

    return {
      content: [
        {
          type: 'text',
          text: `✅ Lead created successfully!\n\nLead ID: ${response.data.id || 'N/A'}\nCustomer: ${args.customer_name}\nEvent Date: ${args.event_date}\n\nFull response:\n${JSON.stringify(response.data, null, 2)}`
        }
      ],
    };
  }

  async getInventory(args) {
    const params = new URLSearchParams({ apiKey: API_KEY });
    if (args.category) params.append('category', args.category);
    if (args.search) params.append('search', args.search);

    const response = await axios.get(`${BASE_URL}/rentals?${params}`);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.data, null, 2)
        }
      ],
    };
  }

  async getCustomers(args) {
    const params = new URLSearchParams({ apiKey: API_KEY });
    if (args.search) params.append('search', args.search);
    if (args.limit) params.append('limit', args.limit);

    const response = await axios.get(`${BASE_URL}/customers?${params}`);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.data, null, 2)
        }
      ],
    };
  }

  async getLeadDetails(args) {
    const response = await axios.get(
      `${BASE_URL}/leads/${args.lead_id}?apiKey=${API_KEY}&_body=true`
    );
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.data, null, 2)
        }
      ],
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('EventOffice MCP server running on stdio');
  }
}

const server = new EventOfficeServer();
server.run().catch(console.error);