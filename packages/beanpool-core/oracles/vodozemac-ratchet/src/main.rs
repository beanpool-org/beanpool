//! Test oracle for packages/beanpool-core/src/ratchet.ts (X8 part 1). Never shipped; nothing in the repo depends on it.
//!
//! Runs one scripted conversation through vodozemac (an independent implementation of Olm, Apache-2.0) for each MAC length,
//! and writes every message, every plaintext, every refusal and the random keys vodozemac chose to
//! packages/beanpool-core/vectors/ratchet-vodozemac.json. The TypeScript test replays the same script with those keys and must
//! produce the same bytes and the same answers.
//!
//! Regenerate (needs Rust; CI never does this, it reads the pinned file):
//!   cd packages/beanpool-core/oracles/vodozemac-ratchet && cargo run --release > ../../vectors/ratchet-vodozemac.json
//!
//! The secrets in the output are throwaway keys made for this run, never anyone's.

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use vodozemac::olm::{Account, OlmMessage, Session, SessionConfig};

fn b(v: &[u8]) -> String {
    STANDARD.encode(v)
}

fn bytes(v: &Value) -> Vec<u8> {
    v.as_array().expect("byte array").iter().map(|x| x.as_u64().expect("byte") as u8).collect()
}

/// The secret half of a session's current sending ratchet key, read from its pickle; None while it has no sending chain.
fn sending_secret(s: &Session) -> Option<Vec<u8>> {
    let p = serde_json::to_value(s.pickle()).unwrap();
    let r = &p["sending_ratchet"];
    if r["type"] == "active" { Some(bytes(&r["active_ratchet"]["ratchet_key"])) } else { None }
}

struct Side {
    session: Option<Session>,
    sent: Vec<(String, OlmMessage)>,
}

fn transcript(config: SessionConfig, mac_bytes: u8) -> Value {
    let alice_account = Account::new();
    let mut bob_account = Account::new();
    bob_account.generate_one_time_keys(1);
    let (_, otk) = bob_account.one_time_keys().into_iter().next().unwrap();
    let bob_pickle = serde_json::to_value(bob_account.pickle()).unwrap();
    let bob_identity_secret = bytes(&bob_pickle["diffie_hellman_key"]);
    let bob_otk_secret = bytes(&bob_pickle["one_time_keys"]["private_keys"]["0"]);

    let alice_session = alice_account.create_outbound_session(config, bob_account.curve25519_key(), otk).unwrap();
    let ap = serde_json::to_value(alice_session.pickle()).unwrap();
    let alice_start = json!({
        "rootKey": b(&bytes(&ap["sending_ratchet"]["active_ratchet"]["root_key"])),
        "ratchetSecret": b(&bytes(&ap["sending_ratchet"]["active_ratchet"]["ratchet_key"])),
        "chainKey": b(&bytes(&ap["sending_ratchet"]["symmetric_key_ratchet"]["key"])),
        "chainIndex": ap["sending_ratchet"]["symmetric_key_ratchet"]["index"],
        "identityKey": b(&bytes(&ap["session_keys"]["identity_key"])),
        "baseKey": b(&bytes(&ap["session_keys"]["base_key"])),
        "oneTimeKey": b(&bytes(&ap["session_keys"]["one_time_key"])),
        "sessionId": alice_session.session_id(),
    });

    let mut alice = Side { session: Some(alice_session), sent: vec![] };
    let mut bob = Side { session: None, sent: vec![] };
    let mut events: Vec<Value> = vec![];
    let long: String = "x".repeat(1000);

    // The script. send: (who, id, plaintext). recv: (who, id). Every row is replayed by the TypeScript test in this order.
    let script: Vec<(&str, &str, &str)> = vec![
        ("send", "alice", "a1|hello from alice"),
        ("send", "alice", "a2|"),
        ("send", "alice", "a3|sixteen bytes!!"),
        ("recv", "bob", "a1"),
        ("recv", "bob", "a3"), // a2 skipped
        ("send", "bob", "b1|kia ora, bob here: ā ē ī ō ū 🌱"),
        ("send", "bob", "b2|LONG"),
        ("recv", "alice", "b2"), // out of order
        ("recv", "alice", "b1"),
        ("send", "alice", "a4|a new ratchet key"),
        ("recv", "bob", "a2"), // late, from the first chain
        ("recv", "bob", "a4"),
        ("send", "alice", "a5|sent while bob sends"),
        ("send", "bob", "b3|sent while alice sends"),
        ("recv", "alice", "b3"),
        ("recv", "bob", "a5"),
        ("recv", "bob", "a5"), // replay
        ("recv", "bob", "a1"), // the first pre-key message again
        ("send", "alice", "a6|after both at once"),
        ("recv", "bob", "a6"),
        ("send", "bob", "b4|last"),
        ("recv", "alice", "b4"),
        ("recv", "alice", "b2"), // replay of an out-of-order one
    ];

    for (op, who, arg) in script {
        match op {
            "send" => {
                let (id, text) = arg.split_once('|').unwrap();
                let text = if text == "LONG" { long.as_str() } else { text };
                let side = if who == "alice" { &mut alice } else { &mut bob };
                let session = side.session.as_mut().expect("a session to send with");
                let message = session.encrypt(text.as_bytes()).unwrap();
                let secret = sending_secret(session).unwrap();
                let (kind, body) = message.to_parts();
                events.push(json!({
                    "op": "send", "who": who, "id": id, "plaintext": b(text.as_bytes()),
                    "type": if kind == 0 { "prekey" } else { "normal" }, "body": b(&body),
                    "ratchetSecret": b(&secret),
                }));
                side.sent.push((id.to_string(), message));
            }
            "recv" => {
                let id = arg;
                let from = if who == "alice" { &bob } else { &alice };
                let message = from.sent.iter().find(|(i, _)| i == id).unwrap().1.clone();
                let result = if who == "bob" && bob.session.is_none() {
                    let OlmMessage::PreKey(pre) = &message else { panic!("first message must be pre-key") };
                    let created = bob_account
                        .create_inbound_session(config, alice_account.curve25519_key(), pre)
                        .unwrap();
                    bob.session = Some(created.session);
                    Ok(created.plaintext)
                } else {
                    let side = if who == "alice" { &mut alice } else { &mut bob };
                    side.session.as_mut().unwrap().decrypt(&message).map_err(|e| format!("{e:?}"))
                };
                events.push(match result {
                    Ok(p) => json!({ "op": "recv", "who": who, "id": id, "ok": true, "plaintext": b(&p) }),
                    Err(e) => json!({ "op": "recv", "who": who, "id": id, "ok": false, "error": e }),
                });
            }
            _ => unreachable!(),
        }
    }

    json!({
        "macBytes": mac_bytes,
        "bob": {
            "identitySecret": b(&bob_identity_secret),
            "identityKey": b(bob_account.curve25519_key().as_bytes()),
            "oneTimeSecret": b(&bob_otk_secret),
            "oneTimeKey": b(otk.as_bytes()),
        },
        "alice": alice_start,
        "events": events,
    })
}

fn main() {
    let out = json!({
        "about": "Written by packages/beanpool-core/oracles/vodozemac-ratchet (vodozemac 0.11.2, Apache-2.0) for src/ratchet.ts. Test oracle only. Throwaway keys.",
        "transcripts": [
            transcript(SessionConfig::version_1(), 8),
            transcript(SessionConfig::version_2(), 32),
        ],
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
