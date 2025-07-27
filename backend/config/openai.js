const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");

const client = new OpenAIClient(
  process.env.OPENAI_API_ENDPOINT,
  new AzureKeyCredential(process.env.OPENAI_API_KEY)
);

module.exports = client;
