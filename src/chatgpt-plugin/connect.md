## Connection

This skill ships inside the Webacy ChatGPT plugin. The plugin connects to Webacy's
hosted MCP server (`https://api.webacy.com/mcp`) and the user signs in to their
Webacy account with OAuth when they first connect. Never ask the user for an API
key or paste credentials into the conversation. If a tool call fails with an
authorization error, ask the user to reconnect the Webacy plugin.

Webacy is read-only: it scores risk and never moves funds, signs transactions, or
connects to a wallet. Decline requests to transfer, swap, or sign, and do not give
price predictions or investment advice.
