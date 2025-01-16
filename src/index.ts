import { Elysia, t } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { SolanaAgentKit, PumpFunTokenOptions } from "solana-agent-kit";
import { VersionedTransaction, Keypair } from "@solana/web3.js";

// Schema Definitions
const TokenOptionsSchema = t.Object({
  initialLiquiditySOL: t.Optional(
    t.Number({
      description: "Initial liquidity in SOL",
      minimum: 0.0001,
      default: 0.0001,
    })
  ),
  slippageBps: t.Optional(
    t.Number({
      description: "Slippage in basis points",
      minimum: 1,
      maximum: 1000,
      default: 5,
    })
  ),
  priorityFee: t.Optional(
    t.Number({
      description: "Priority fee in SOL",
      minimum: 0.00001,
      default: 0.00005,
    })
  ),
});

const TokenLaunchRequestSchema = t.Object({
  tokenName: t.String({
    description: "Name of the token",
    minLength: 1,
    maxLength: 32,
  }),
  tokenTicker: t.String({
    description: "Token ticker symbol",
    minLength: 2,
    maxLength: 10,
    pattern: "^[A-Z0-9]+$",
  }),
  description: t.String({
    description: "Token description",
    minLength: 1,
    maxLength: 1000,
  }),
  imageUrl: t.String({
    description: "Token image URL",
    pattern: "^https?://",
  }),
  privateKey: t.String({
    description: "Solana wallet private key",
  }),
  rpcUrl: t.Optional(
    t.String({
      description: "Solana RPC URL",
      default: "https://api.devnet.solana.com",
    })
  ),
  options: t.Optional(TokenOptionsSchema),
});

const TokenLaunchResponseSchema = t.Object({
  success: t.Boolean(),
  data: t.Optional(
    t.Object({
      signature: t.String({
        description: "Transaction signature",
      }),
      mintAddress: t.String({
        description: "Token mint address",
      }),
      metadataUri: t.String({
        description: "IPFS metadata URI",
      }),
    })
  ),
  error: t.Optional(t.String()),
});

const app = new Elysia()
  .use(
    swagger({
      path: "/docs",
      documentation: {
        info: {
          title: "Meme Token API",
          version: "1.0.0",
          description: "API for launching meme tokens on Solana using Pump.fun",
        },
      },
    })
  )
  .post(
    "/launch-token",
    async ({ body }) => {
      try {
        const mintKeypair = Keypair.generate();
        const agent = new SolanaAgentKit(
          body.privateKey,
          body.rpcUrl || "https://api.devnet.solana.com",
          null
        );

        const metadataResponse = await uploadMetadata(
          body.tokenName,
          body.tokenTicker,
          body.description,
          body.imageUrl,
          body.options
        );

        const txResponse = await createTokenTransaction(
          agent,
          mintKeypair,
          metadataResponse,
          body.options
        );

        const txData = await txResponse.arrayBuffer();
        const tx = VersionedTransaction.deserialize(new Uint8Array(txData));

        const signature = await signAndSendTransaction(agent, tx, mintKeypair);

        return {
          success: true,
          data: {
            signature,
            mintAddress: mintKeypair.publicKey.toBase58(),
            metadataUri: metadataResponse.metadataUri,
          },
        };
      } catch (error) {
        console.error("Token launch error:", error);
        return {
          success: false,
          error:
            error instanceof Error ? error.message : "Unknown error occurred",
        };
      }
    },
    {
      body: TokenLaunchRequestSchema,
      response: TokenLaunchResponseSchema,
      detail: {
        summary: "Launch new meme token",
      },
    }
  )
  .listen(3000);

async function uploadMetadata(
  tokenName: string,
  tokenTicker: string,
  description: string,
  imageUrl: string,
  options?: PumpFunTokenOptions
) {
  // Create form
  const formData = new URLSearchParams();
  formData.append("name", tokenName);
  formData.append("symbol", tokenTicker);
  formData.append("description", description);
  formData.append("showName", "true");

  // Get token image
  const imageResponse = await fetch(imageUrl);
  const imageBlob = await imageResponse.blob();
  const finalFormData = new FormData();
  for (const [key, value] of formData.entries()) {
    finalFormData.append(key, value);
  }
  finalFormData.append(
    "file",
    new File([imageBlob], "token_image.png", { type: "image/png" })
  );

  // Send request
  const response = await fetch("https://pump.fun/api/ipfs", {
    method: "POST",
    body: finalFormData,
  });
  if (!response.ok)
    throw new Error(`Metadata upload failed: ${response.statusText}`);
  return response.json();
}

async function createTokenTransaction(
  agent: SolanaAgentKit,
  mintKeypair: Keypair,
  metadataResponse: any,
  options?: PumpFunTokenOptions
) {
  const response = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey: agent.wallet_address.toBase58(),
      action: "create",
      tokenMetadata: {
        name: metadataResponse.metadata.name,
        symbol: metadataResponse.metadata.symbol,
        uri: metadataResponse.metadataUri,
      },
      mint: mintKeypair.publicKey.toBase58(),
      denominatedInSol: "true",
      amount: options?.initialLiquiditySOL || 0.0001,
      slippage: options?.slippageBps || 5,
      priorityFee: options?.priorityFee || 0.00005,
      pool: "pump",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Transaction creation failed: ${response.status} - ${errorText}`
    );
  }

  return response;
}

async function signAndSendTransaction(
  agent: SolanaAgentKit,
  tx: VersionedTransaction,
  mintKeypair: Keypair
) {
  const { blockhash, lastValidBlockHeight } =
    await agent.connection.getLatestBlockhash();
  tx.message.recentBlockhash = blockhash;
  tx.sign([mintKeypair, agent.wallet]);

  const signature = await agent.connection.sendTransaction(tx, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 5,
  });

  const confirmation = await agent.connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  });

  if (confirmation.value.err) {
    throw new Error(`Transaction failed: ${confirmation.value.err}`);
  }

  return signature;
}

console.log(
  `🚀 Meme Token API running: http://${app.server?.hostname}:${app.server?.port}/docs`
);
