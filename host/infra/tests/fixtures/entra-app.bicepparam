using '../../bootstrap/entra-app.bicep'

// entra-app fixture. Dummy, non-secret object id.
param displayName = 'hve-squad MCP (fixture)'
param uniqueName = 'hve-squad-mcp-fixture'
param ownerObjectIds = [
  '55555555-5555-5555-5555-555555555555'
]