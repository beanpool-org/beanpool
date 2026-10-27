import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { keys } from 'npm:@libp2p/crypto@5.1.13';
import { peerIdFromPublicKey } from 'npm:@libp2p/peer-id@6.0.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-signature, x-public-key',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const signatureHex = req.headers.get('x-signature');
    const pubKeyHex = req.headers.get('x-public-key');

    if (!signatureHex || !pubKeyHex) {
      return new Response(JSON.stringify({ error: 'Missing signature headers' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Read raw body for exact signature verification
    const rawBody = await req.text();
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!payload.nodeId || !payload.callsign || !payload.timestamp) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 1. Replay Attack Prevention (5 minute window)
    const now = Date.now();
    const payloadTime = payload.timestamp;
    if (Math.abs(now - payloadTime) > 5 * 60 * 1000) {
      return new Response(JSON.stringify({ error: 'Timestamp Expired' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Decode hex keys
    const decodeHex = (hex: string) => {
      const match = hex.match(/.{1,2}/g);
      if (!match) return new Uint8Array();
      return new Uint8Array(match.map(byte => parseInt(byte, 16)));
    };

    const pubKeyBytes = decodeHex(pubKeyHex);
    const signatureBytes = decodeHex(signatureHex);

    let publicKey;
    try {
      publicKey = keys.publicKeyFromProtobuf(pubKeyBytes);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid Public Key format' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 2. PeerId Verification
    try {
      const derivedPeerId = peerIdFromPublicKey(publicKey).toString();
      if (derivedPeerId !== payload.nodeId) {
        return new Response(JSON.stringify({ error: 'PeerId Mismatch' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    } catch (e) {
      return new Response(JSON.stringify({ error: 'PeerId Mismatch' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 3. Signature Verification
    try {
      const isValid = await publicKey.verify(new TextEncoder().encode(rawBody), signatureBytes);
      if (!isValid) {
        return new Response(JSON.stringify({ error: 'Invalid Signature' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid Signature' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Authenticated! Update database.
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // The listing promise (BeanPool #2142, mothership A2). Always set, null when absent or of the wrong shape, so an older
    // node's push or a lapsed promise clears it; a wrong shape is stored as null, never refused.
    const PROMISE_KEYS = ['v', 'owners', 'backups', 'reports', 'notice'];
    const promise = (() => {
      const p = payload.promise;
      if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
      const k = Object.keys(p);
      if (k.length !== PROMISE_KEYS.length || !PROMISE_KEYS.every((key) => k.includes(key))) return null;
      if (p.v !== 1 || !Number.isInteger(p.owners) || p.owners < 2 || p.owners > 1000) return null;
      if (p.backups !== true || p.reports !== true || p.notice !== true) return null;
      return { v: 1, owners: p.owners, backups: true, reports: true, notice: true };
    })();
    const realDay = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
      && !isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

    const { data, error } = await supabaseClient
      .from('directory_nodes')
      .upsert({
        node_id: payload.nodeId,
        callsign: payload.callsign,
        community_name: payload.communityName || null,
        service_radius: payload.serviceRadius || null,
        member_count: payload.memberCount || 0,
        contact_email: payload.contactEmail || null,
        contact_phone: payload.contactPhone || null,
        node_version: payload.nodeVersion || null,
        node_url: payload.publicUrl || null,
        promise,
        accepting_knocks: typeof payload.acceptingKnocks === 'boolean' ? payload.acceptingKnocks : null,
        closing_on: realDay(payload.closingOn) ? payload.closingOn : null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'node_id' });

    if (error) throw error;

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('Error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
