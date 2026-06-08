// analyze-reviews — v20
// Adds: dealer vertical (discover_zone action, automotive Claude prompt, vertical-aware analyze/sync)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const GOOGLE_KEY    = Deno.env.get("GOOGLE_PLACES_API_KEY")!;
// Gemini handles audio (Claude doesn't accept audio input). Prefer a dedicated
// GEMINI_API_KEY secret; fall back to the Google Cloud key if the Generative
// Language API is enabled on that project.
const GEMINI_KEY    = Deno.env.get("GEMINI_API_KEY") ?? GOOGLE_KEY;
const GEMINI_MODEL  = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.0-flash";
const SUPA_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPA_SVC      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPA_URL, SUPA_SVC);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function slug(name: string): string {
  return name.toLowerCase()
    .replace(/[áàäâ]/g,"a").replace(/[éèëê]/g,"e")
    .replace(/[íìïî]/g,"i").replace(/[óòöô]/g,"o")
    .replace(/[úùüû]/g,"u").replace(/ñ/g,"n")
    .replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")
    + "-" + Math.random().toString(36).substring(2,6);
}

async function callClaude(prompt: string): Promise<unknown> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 5000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const d = await res.json();
  const text: string = d.content?.[0]?.text ?? "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No JSON in Claude response");
  return JSON.parse(m[0]);
}

// Transcribe + summarize an audio note via Gemini (accepts inline audio).
async function summarizeAudio(
  audioBase64: string,
  mimeType: string,
  context: string,
): Promise<Record<string, unknown>> {
  const prompt = `Eres un asistente que procesa notas de voz y llamadas de clientes para un sistema de "Voz del Cliente".
Escucha el audio adjunto y devuelve EXCLUSIVAMENTE un JSON válido (sin texto antes ni después) con esta estructura:
{
  "language": "código ISO del idioma hablado (es, en, ...)",
  "transcript": "transcripción literal y completa del audio",
  "summary": "resumen ejecutivo en español, 2-4 frases",
  "key_points": ["punto clave 1", "punto clave 2"],
  "sentiment": "positivo|neutro|negativo",
  "topics": ["tema 1", "tema 2"],
  "action_items": ["acción o seguimiento sugerido 1"]
}
Reglas: el resumen, key_points, topics y action_items SIEMPRE en español aunque el audio esté en otro idioma. La transcripción en el idioma original. Si el audio no contiene voz, devuelve transcript:"" y un summary que lo indique, con arrays vacíos.${context ? `\nContexto adicional aportado por el usuario: ${context}` : ""}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: audioBase64 } },
          ],
        }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
      }),
    },
  );

  const d = await res.json();
  if (!res.ok) {
    const msg = d?.error?.message ?? `Gemini error ${res.status}`;
    throw new Error(msg);
  }
  const text: string = d.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No JSON in Gemini response");
  return JSON.parse(m[0]);
}

// ── Prompts ──────────────────────────────────────────────────────────────────

function hotelPrompt(profile: Record<string,unknown>, reviews: string[]): string {
  return `Eres un analista experto en experiencia del cliente para hoteles. Analiza las siguientes reviews del hotel "${profile.name}" en "${profile.location}"${profile.stars ? ` (${profile.stars} estrellas)` : ""}.

REVIEWS (${reviews.length}):
${reviews.map((r,i) => `${i+1}. "${r}"`).join("\n")}

Devuelve EXCLUSIVAMENTE un JSON válido (sin texto antes ni después) con esta estructura:
{
  "voc_score": <0-100>,
  "nps_estimated": <-100 a 100>,
  "categories": {
    "habitacion": <0-100>, "staff": <0-100>, "fb": <0-100>,
    "instalaciones": <0-100>, "ubicacion": <0-100>,
    "valor": <0-100>, "tecnologia": <0-100>, "sostenibilidad": <0-100>
  },
  "strengths": [{"text":"...","quote":"cita breve"}],
  "improvements": [{"text":"...","quote":"cita breve"}],
  "summary": "resumen ejecutivo 2-3 frases",
  "alerts": [
    {
      "priority": "P0|P1|P2|P3|P4",
      "title":"...", "summary":"...", "affected_area":"...",
      "evidence":["cita1","cita2"], "immediate_action":"...", "reasoning":"...",
      "guest_name":"(solo si P0)", "promise_broken":"(solo si P0)", "suggested_response":"(solo si P0)"
    }
  ],
  "insights": [
    {
      "type":"strength|warning|opportunity",
      "title":"...", "description":"...", "reasoning":"...",
      "evidence":["cita1"], "action":"recomendación"
    }
  ],
  "compliments": [{"person":"nombre","role":"cargo","quote":"cita"}]
}

Reglas alertas: P0=huésped individual grave (incluye guest_name), P1=fraude/amenaza legal, P2=patrón urgente (<7 días), P3=tendencia negativa, P4=oportunidad.
Solo alertas respaldadas por las reviews. Si no hay: "alerts":[]
Compliments: solo si alguien es mencionado por NOMBRE con elogio específico.`;
}

function dealerPrompt(profile: Record<string,unknown>, reviews: string[]): string {
  const brands = (profile.brands as string[] | undefined ?? ["volkswagen"]).join(", ");
  return `Eres un analista experto en experiencia del cliente para concesionarios del grupo Volkswagen. Analiza las siguientes reviews del concesionario "${profile.name}" en "${profile.location}", que comercializa: ${brands}.

REVIEWS (${reviews.length}):
${reviews.map((r,i) => `${i+1}. "${r}"`).join("\n")}

Devuelve EXCLUSIVAMENTE un JSON válido (sin texto antes ni después) con esta estructura:
{
  "voc_score": <0-100, índice compuesto global>,
  "nps_estimated": <-100 a 100>,
  "sales_experience_index": <0-100, score proceso de venta + entrega>,
  "aftersales_experience_index": <0-100, score taller y postventa>,
  "sale_service_gap": <diferencia absoluta entre los dos índices anteriores>,
  "categories": {
    "comercial": <0-100>, "entrega": <0-100>, "taller": <0-100>,
    "atencion": <0-100>, "instalaciones": <0-100>,
    "precio": <0-100>, "digital": <0-100>, "producto": <0-100>
  },
  "strengths": [{"text":"...","quote":"cita breve"}],
  "improvements": [{"text":"...","quote":"cita breve"}],
  "summary": "resumen ejecutivo 2-3 frases, destaca brecha venta-taller si existe",
  "alerts": [
    {
      "priority": "P1|P2|P3|P4",
      "rule_code": "D-C01|D-C02|D-C03|D-C04|D-U01|D-U02|D-U03|D-U04|D-U05|D-A01|D-A02|D-A03|D-A04|D-O01|D-O02|D-O03|D-O04|D-O05",
      "title":"...", "summary":"...", "affected_area":"venta|taller|atencion|general",
      "evidence":["cita1","cita2"], "immediate_action":"...", "reasoning":"..."
    }
  ],
  "insights": [
    {
      "type":"strength|warning|opportunity",
      "title":"...", "description":"...", "reasoning":"...",
      "evidence":["cita1"], "action":"recomendación"
    }
  ],
  "compliments": [{"person":"nombre comercial/mecánico","role":"cargo","quote":"cita"}]
}

Códigos de alerta:
D-C01(P1): estafa, engaño, coche con daños/km manipulado
D-C02(P1): vehículo peligroso entregado (frenos, avería grave, accidente)
D-C03(P1): avalancha de reviews negativas
D-C04(P1): amenaza legal, abogado, OCU, denuncia
D-U01(P2): patrón de problemas en taller (mismo problema varias veces)
D-U02(P2): comercial problemático mencionado varias veces negativamente
D-U03(P2): caída notable del sentimiento general
D-U04(P2): fuga al taller independiente (mencionan otros talleres más baratos)
D-U05(P2): patrón de quejas sobre gestión de garantías
D-A01(P3): brecha venta-taller creciente (sale_service_gap > 20)
D-A02(P3): competidor mejorando mencionado en reviews
D-A03(P3): reviews sin respuesta del concesionario
D-A04(P3): frustración generalizada con plazos de entrega
D-O01(P4): super-promotor con mención de comercial y recomendación explícita
D-O02(P4): momento wow en la entrega del vehículo
D-O03(P4): mejora notable en percepción de taller
D-O04(P4): ventaja competitiva clara en alguna categoría
D-O05(P4): cliente recuperado (queja resuelta + recomendación posterior)

IMPORTANTE: Si sale_service_gap > 15, incluye siempre un insight "warning" sobre la brecha venta-postventa.
Solo alertas claramente respaldadas por reviews. Si no hay: "alerts":[]`;
}

// ── Places helpers ────────────────────────────────────────────────────────────

async function getPlaceDetails(placeId: string) {
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,rating,reviews,user_ratings_total,formatted_address,photos,icon&key=${GOOGLE_KEY}&language=es&reviews_sort=newest`;
  const res = await fetch(url);
  return (await res.json()).result ?? {};
}

function formatReviewsData(reviews: Array<Record<string,unknown>>) {
  return reviews.map(r => ({
    text: r.text,
    rating: r.rating,
    author_name: r.author_name,
    relative_time: r.relative_time_description,
  }));
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = await req.json();
    const { action } = body;

    // ── search_places ──────────────────────────────────────────────────────
    if (action === "search_places") {
      const { query, type } = body;
      const typeParam = type ? `&type=${type}` : "";
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}${typeParam}&key=${GOOGLE_KEY}&language=es`;
      const res = await fetch(url);
      const d = await res.json();
      const places = (d.results ?? []).slice(0,6).map((p: Record<string,unknown>) => ({
        place_id: p.place_id,
        name: p.name,
        address: p.formatted_address,
        rating: p.rating,
        total_reviews: p.user_ratings_total,
      }));
      return json({ places });
    }

    // ── discover_zone ──────────────────────────────────────────────────────
    if (action === "discover_zone") {
      const { location, brands = ["volkswagen"] } = body as {
        location: string; radius_km?: number; brands?: string[];
      };

      // Use textsearch (no geocoding needed — same API already enabled)
      const brandName = (brands[0] ?? "volkswagen").charAt(0).toUpperCase() + (brands[0] ?? "volkswagen").slice(1);
      const query = `concesionario ${brandName} en ${location}`;
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&type=car_dealer&key=${GOOGLE_KEY}&language=es`;
      const res = await fetch(url);
      const data = await res.json();

      const dealers = (data.results ?? []).slice(0, 12).map((p: Record<string, unknown>) => ({
        place_id: p.place_id,
        name: p.name,
        address: p.formatted_address,
        rating: p.rating,
        total_reviews: p.user_ratings_total,
      }));
      return json({ dealers });
    }

    // ── fetch_reviews ──────────────────────────────────────────────────────
    if (action === "fetch_reviews") {
      const { place_id } = body;
      const place = await getPlaceDetails(place_id);
      const reviews: string[] = (place.reviews ?? []).map((r: Record<string,unknown>) => r.text as string);
      const reviewsData = formatReviewsData(place.reviews ?? []);
      let photo_url: string | null = null;
      if (place.photos?.[0]?.photo_reference) {
        photo_url = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=1200&photo_reference=${place.photos[0].photo_reference}&key=${GOOGLE_KEY}`;
      }
      return json({ reviews, reviewsData, photo_url, logo_url: place.icon ?? null, total_reviews: place.user_ratings_total, rating: place.rating, name: place.name });
    }

    // ── summarize_audio ──────────────────────────────────────────────────────
    if (action === "summarize_audio") {
      const { audio_base64, mime_type = "audio/mp4", context = "" } = body as {
        audio_base64?: string; mime_type?: string; context?: string;
      };
      if (!audio_base64) return json({ error: "Missing audio_base64" }, 400);
      const result = await summarizeAudio(audio_base64, mime_type, context);
      return json(result);
    }

    // ── analyze ────────────────────────────────────────────────────────────
    if (action === "analyze") {
      const { hotel_profile, reviews, reviews_data, source, vertical = "hotel" } = body as {
        hotel_profile: Record<string,unknown>;
        reviews: string[];
        reviews_data?: unknown[];
        source: string;
        vertical?: string;
      };

      const truncated = reviews.map((r) => r.substring(0, 400));
      const prompt = vertical === "dealer"
        ? dealerPrompt(hotel_profile, truncated)
        : hotelPrompt(hotel_profile, truncated);

      const analysis = await callClaude(prompt) as Record<string, unknown>;

      const hotelSlug = slug(hotel_profile.name as string);

      const { data: hotel, error: hErr } = await supabase
        .from("hotels")
        .upsert({
          name: hotel_profile.name,
          location: hotel_profile.location,
          stars: hotel_profile.stars ?? null,
          type: hotel_profile.type ?? null,
          slug: hotelSlug,
          place_id: hotel_profile.place_id ?? null,
          photo_url: hotel_profile.photo_url ?? null,
          logo_url: hotel_profile.logo_url ?? null,
          competitors: hotel_profile.competitors ?? [],
          focus_areas: hotel_profile.focus_areas ?? [],
          vertical,
          brands: hotel_profile.brands ?? [],
          services: hotel_profile.services ?? [],
        })
        .select()
        .single();
      if (hErr) throw new Error(hErr.message);

      const { data: analysisRow, error: aErr } = await supabase
        .from("analyses")
        .insert({
          hotel_id: hotel.id,
          voc_score: analysis.voc_score,
          nps_estimated: analysis.nps_estimated ?? null,
          categories: analysis.categories,
          strengths: analysis.strengths,
          improvements: analysis.improvements,
          summary: analysis.summary,
          alerts: analysis.alerts ?? [],
          insights: analysis.insights ?? [],
          compliments: analysis.compliments ?? [],
          reviews_data: reviews_data ?? [],
          source,
        })
        .select()
        .single();
      if (aErr) throw new Error(aErr.message);

      return json({ ...analysis, slug: hotel.slug, analysis_id: analysisRow.id });
    }

    // ── sync ───────────────────────────────────────────────────────────────
    if (action === "sync") {
      const { place_id, hotel_slug, hotel_profile, vertical: syncVertical } = body as {
        place_id: string;
        hotel_slug: string;
        hotel_profile: Record<string,unknown>;
        vertical?: string;
      };

      const place = await getPlaceDetails(place_id);
      const reviews: string[] = (place.reviews ?? []).map((r: Record<string,unknown>) => r.text as string);
      const reviewsData = formatReviewsData(place.reviews ?? []);

      // Determine vertical: prefer request body, else DB
      let vertical = syncVertical ?? "hotel";
      if (!syncVertical) {
        const { data: h } = await supabase.from("hotels").select("vertical").eq("slug", hotel_slug).single();
        if (h?.vertical) vertical = h.vertical;
      }

      const truncated = reviews.map((r) => r.substring(0, 400));
      const prompt = vertical === "dealer"
        ? dealerPrompt(hotel_profile, truncated)
        : hotelPrompt(hotel_profile, truncated);

      const analysis = await callClaude(prompt) as Record<string, unknown>;

      // Update latest analysis
      const { data: hotelRow } = await supabase.from("hotels").select("id").eq("slug", hotel_slug).single();
      if (hotelRow) {
        const { data: existing } = await supabase
          .from("analyses").select("id").eq("hotel_id", hotelRow.id)
          .order("created_at", { ascending: false }).limit(1).single();
        if (existing) {
          await supabase.from("analyses").update({
            voc_score: analysis.voc_score,
            nps_estimated: analysis.nps_estimated ?? null,
            categories: analysis.categories,
            strengths: analysis.strengths,
            improvements: analysis.improvements,
            summary: analysis.summary,
            alerts: analysis.alerts ?? [],
            insights: analysis.insights ?? [],
            compliments: analysis.compliments ?? [],
            reviews_data: reviewsData,
            source: "Google Reviews (sync)",
          }).eq("id", existing.id);
        }
      }

      let photo_url: string | null = null;
      if (place.photos?.[0]?.photo_reference) {
        photo_url = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=1200&photo_reference=${place.photos[0].photo_reference}&key=${GOOGLE_KEY}`;
      }

      return json({ ...analysis, reviewsData, photo_url });
    }

    // ── benchmark ──────────────────────────────────────────────────────────
    if (action === "benchmark") {
      const { hotel_name, hotel_scores, competitors, location, analysis_id } = body as {
        hotel_name: string;
        hotel_scores: { voc_score: number; categories: Record<string,number> };
        competitors: string[];
        location: string;
        analysis_id?: string;
      };

      const results: unknown[] = [{
        name: hotel_name,
        voc_score: hotel_scores.voc_score,
        categories: hotel_scores.categories,
        is_current: true,
      }];

      for (const comp of competitors) {
        try {
          const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(comp + " " + location)}&key=${GOOGLE_KEY}&language=es`;
          const sr = await fetch(searchUrl);
          const sd = await sr.json();
          const place_id = sd.results?.[0]?.place_id;
          if (!place_id) { results.push({ name: comp, voc_score: 0, categories: {}, is_current: false }); continue; }

          const place = await getPlaceDetails(place_id);
          const reviews: string[] = (place.reviews ?? []).map((r: Record<string,unknown>) => (r.text as string).substring(0, 400));
          if (!reviews.length) { results.push({ name: comp, voc_score: 0, categories: {}, is_current: false }); continue; }

          const compAnalysis = await callClaude(hotelPrompt({ name: comp, location }, reviews)) as Record<string, unknown>;
          results.push({ name: comp, voc_score: compAnalysis.voc_score, categories: compAnalysis.categories, is_current: false });
        } catch {
          results.push({ name: comp, voc_score: 0, categories: {}, is_current: false });
        }
      }

      if (analysis_id) {
        await supabase.from("analyses").update({ benchmark: results }).eq("id", analysis_id);
      }

      return json({ results });
    }

    // ── load ───────────────────────────────────────────────────────────────
    if (action === "load") {
      const { slug: s } = body;
      const { data: hotel } = await supabase.from("hotels").select("*").eq("slug", s).single();
      if (!hotel) return json({ error: "Not found" }, 404);
      const { data: analysis } = await supabase
        .from("analyses").select("*").eq("hotel_id", hotel.id)
        .order("created_at", { ascending: false }).limit(1).single();
      return json({ hotel, analysis });
    }

    // ── update_team ────────────────────────────────────────────────────────
    if (action === "update_team") {
      const { slug: s, team } = body;
      if (!s || typeof team !== "object") return json({ error: "Invalid payload" }, 400);
      await supabase.from("hotels").update({ team }).eq("slug", s);
      return json({ ok: true });
    }

    // ── save_assignment ────────────────────────────────────────────────────
    if (action === "save_assignment") {
      const { analysis_id, assignments } = body;
      if (!analysis_id) return json({ error: "Missing analysis_id" }, 400);
      await supabase.from("analyses").update({ assignments }).eq("id", analysis_id);
      return json({ ok: true });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
