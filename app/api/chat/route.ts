export const maxDuration = 30;

type ClientMessage = {
  role: "user" | "assistant";
  content: string;
};

type StoredConversation = {
  messages: ClientMessage[];
  expiresAt: number;
};

const CONVO_TTL_MS = 60 * 60 * 1000; // 1 hour
const conversations = new Map<string, StoredConversation>();

function cleanupExpired() {
  const now = Date.now();
  for (const [k, v] of conversations) {
    if (v.expiresAt <= now) conversations.delete(k);
  }
}

export async function POST(req: Request) {
  try {
    const {
      messages,
      sessionId,
    }: { messages: ClientMessage[]; sessionId?: string } = await req.json();

    cleanupExpired();
    const sid = sessionId || crypto.randomUUID();

    const apiKey = process.env.GEMINI_API_KEY;
    const model = "gemini-2.5-flash";

    if (!apiKey) {
      return new Response("Missing GEMINI_API_KEY", { status: 500 });
    }

    // Map client messages to Gemini "contents" format
    const contents = (messages || []).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    // Store conversation before sending
    const toStore = (messages || []).filter(
      (m) => !(m.role === "assistant" && !m.content)
    );
    conversations.set(sid, {
      messages: toStore,
      expiresAt: Date.now() + CONVO_TTL_MS,
    });

    // ✅ Directly use one model (no loop)
    const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(
      model
    )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents }),
      signal: req.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => "");
      return new Response(
        `Upstream error: ${upstream.status} ${upstream.statusText}\n${errText}`,
        {
          status: 502,
        }
      );
    }

    // ✅ Parse SSE and stream text to client
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const reader = upstream.body.getReader();

    const stream = new ReadableStream({
      async start(controller) {
        let fullText = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          // Match lines starting with data:
          const matches = [...chunk.matchAll(/data:\s*(\{.*\})/g)];
          for (const match of matches) {
            try {
              const json = JSON.parse(match[1]);
              const text =
                json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
              if (text) {
                fullText += text;
                controller.enqueue(encoder.encode(text));
              }
            } catch {}
          }
        }

        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    console.error("Error:", err);
    return new Response("Bad Request", { status: 400 });
  }
}
