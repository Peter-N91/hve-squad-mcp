// Shared user-defined types (compile-time import; GA in Bicep, not experimental).

@export()
@description('One Azure OpenAI model deployment to create in openAiMode "create". skuName/capacity default to the cost-council indicative starting point (K1): GlobalStandard, capacity 10 — size them to your expected load.')
type OpenAiDeployment = {
  @description('Deployment name. The first entry becomes the effective SQUAD_MCP_MODEL_DEPLOYMENT in create mode.')
  name: string
  @description('Model name, e.g. gpt-4o.')
  modelName: string
  @description('Model version, e.g. 2024-11-20.')
  modelVersion: string
  @description('Model format (default OpenAI).')
  modelFormat: string?
  @description('Deployment SKU (default GlobalStandard, K1).')
  skuName: string?
  @description('Deployment capacity in thousands of tokens per minute (default 10, K1).')
  capacity: int?
}
