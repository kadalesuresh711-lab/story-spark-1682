import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { writePrompts } from "@/lib/manga.server";

const Input = z
  .object({
    bible: z.string().max(10_000),
    from: z.number().int().min(1),
    to: z.number().int().min(1),
    segments: z
      .array(
        z.object({
          index: z.number().int(),
          start: z.number(),
          end: z.number(),
          text: z.string().max(20_000),
        }),
      )
      .min(1)
      .max(10_000),
  })
  .refine((value) => value.to >= value.from && value.to - value.from < 60, {
    message: "Prompt range must contain 1 to 60 lines",
  });

export const Route = createFileRoute("/api/prompts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let input: z.infer<typeof Input>;
        try {
          input = Input.parse(await request.json());
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid request";
          return Response.json({ error: message }, { status: 400 });
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            let closed = false;
            const send = (event: string, data: unknown) => {
              if (closed) return;
              controller.enqueue(
                encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
              );
            };

            // Flush response headers immediately, then keep the published
            // connection active while Agnes streams its long answer upstream.
            send("started", { from: input.from, to: input.to });
            const heartbeat = setInterval(() => send("heartbeat", { at: Date.now() }), 10_000);

            void writePrompts(input.bible, input.segments, input.from, input.to)
              .then((prompts) => send("result", { prompts }))
              .catch((error) =>
                send("failure", {
                  error: error instanceof Error ? error.message : String(error),
                }),
              )
              .finally(() => {
                clearInterval(heartbeat);
                closed = true;
                controller.close();
              });
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});