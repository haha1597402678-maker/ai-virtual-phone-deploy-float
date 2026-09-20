import { NextResponse } from "next/server";
import { proxyFetch } from "@/lib/proxy-fetch";

export const runtime = "nodejs";
// ElevenLabs 合成通常 1-5 秒，冷启动更久；这里给足余量（实际时长仍受平台函数上限约束）。
export const maxDuration = 60;

const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";
const DEFAULT_ELEVENLABS_MODEL = "eleven_multilingual_v2";

function normalizeBaseUrl(value: unknown): string {
    const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_ELEVENLABS_BASE_URL;
    return raw.replace(/\/+$/, "");
}

/** ElevenLabs 的错误体形如 {detail:{message,status}} 或 {detail:"..."}，取出可读文案。 */
function upstreamMessage(text: string, status: number): string {
    try {
        const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown };
        const detail = parsed.detail;
        if (detail && typeof detail === "object") {
            const message = (detail as { message?: unknown }).message;
            if (typeof message === "string" && message.trim()) return message.trim().slice(0, 300);
        }
        if (typeof detail === "string" && detail.trim()) return detail.trim().slice(0, 300);
        if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim().slice(0, 300);
    } catch { /* 非 JSON，落回原文 */ }
    return (text || `HTTP ${status}`).slice(0, 300);
}

export async function POST(request: Request) {
    try {
        return await handleSynthesize(request);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: "tts_failed", message: message.slice(0, 500) }, { status: 502 });
    }
}

async function handleSynthesize(request: Request) {
    const body = await request.json().catch(() => ({}));
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const text = typeof body.text === "string" ? body.text : "";
    const voiceId = typeof body.voiceId === "string" ? body.voiceId.trim() : "";
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : DEFAULT_ELEVENLABS_MODEL;
    const baseUrl = normalizeBaseUrl(body.baseUrl);

    if (!apiKey) return NextResponse.json({ error: "missing_api_key" }, { status: 400 });
    if (!text.trim()) return NextResponse.json({ error: "empty_text" }, { status: 400 });
    if (!voiceId) return NextResponse.json({ error: "missing_voice_id" }, { status: 400 });

    const response = await proxyFetch(
        `${baseUrl}/text-to-speech/${encodeURIComponent(voiceId)}`,
        {
            method: "POST",
            headers: {
                "xi-api-key": apiKey,
                "Content-Type": "application/json",
                Accept: "audio/mpeg",
            },
            body: JSON.stringify({ text, model_id: model }),
        },
    );

    if (!response.ok) {
        const raw = await response.text().catch(() => "");
        return NextResponse.json(
            { error: "tts_failed", message: upstreamMessage(raw, response.status) },
            { status: 502 },
        );
    }

    const audio = await response.arrayBuffer();
    if (!audio.byteLength) {
        return NextResponse.json(
            { error: "empty_audio", message: "ElevenLabs 未返回音频数据" },
            { status: 502 },
        );
    }

    return new NextResponse(audio, {
        status: 200,
        headers: {
            "Content-Type": "audio/mpeg",
            "Cache-Control": "no-store",
        },
    });
}
