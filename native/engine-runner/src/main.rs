//! Local Akagi inference over a bounded JSONL protocol.
use native_bot::{
    defaults,
    engine::{BotAction, Engine},
    mjai_compat,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{self, BufRead, Write};

const SOURCE: &str = "63cea4b5d23d83bbee8d56bc3b9d547cca2046c3";
const MAX: usize = 1_048_576;
struct Runner {
    engine: Option<Engine>,
    epoch: Option<String>,
    hand: Option<String>,
    events: Vec<String>,
    friend_east: bool,
}
fn tile(p: &str) -> Result<String, &'static str> {
    Ok(match p {
        "E" => "1z",
        "S" => "2z",
        "W" => "3z",
        "N" => "4z",
        "P" => "5z",
        "F" => "6z",
        "C" => "7z",
        _ => p,
    }
    .to_owned())
}
fn tiles(ps: Vec<String>) -> Result<Vec<String>, &'static str> {
    ps.iter().map(|p| tile(p)).collect()
}
fn advice(a: BotAction) -> Result<Value, &'static str> {
    Ok(match a {
        BotAction::Dahai { pai, tsumogiri } => {
            json!({"kind":"discard","tile":tile(&pai)?,"tsumogiri":tsumogiri})
        }
        // Upstream Reach lacks tsumogiri. Reject rather than inventing required parameters.
        BotAction::Reach { .. } => return Err("INCOMPLETE_ENGINE_ACTION"),
        BotAction::Chi {
            target,
            pai,
            consumed,
        } => {
            json!({"kind":"chi","fromSeat":target,"calledTile":tile(&pai)?,"consumed":tiles(consumed)?})
        }
        BotAction::Pon {
            target,
            pai,
            consumed,
        } => {
            json!({"kind":"pon","fromSeat":target,"calledTile":tile(&pai)?,"consumed":tiles(consumed)?})
        }
        BotAction::Daiminkan {
            target,
            pai,
            consumed,
        } => {
            json!({"kind":"open-kan","fromSeat":target,"calledTile":tile(&pai)?,"consumed":tiles(consumed)?})
        }
        BotAction::Ankan { consumed } => json!({"kind":"closed-kan","tiles":tiles(consumed)?}),
        BotAction::Kakan { pai, consumed } => {
            json!({"kind":"added-kan","existingPon":tiles(consumed)?,"addedTile":tile(&pai)?})
        }
        BotAction::Pass => json!({"kind":"pass"}),
        _ => return Err("UNSUPPORTED_ENGINE_ACTION"),
    })
}
impl Runner {
    fn call(&mut self, r: &Value) -> Result<Value, &'static str> {
        let epoch = r["runnerEpoch"].as_str().ok_or("INVALID_EPOCH")?;
        if let Some(e) = &self.epoch {
            if e != epoch {
                return Err("RUNNER_EPOCH_MISMATCH");
            }
        }
        let p = &r["params"];
        let method = r["method"].as_str().ok_or("INVALID_METHOD")?;
        let model_hash = format!("sha256:{:x}", Sha256::digest(defaults::WEIGHTS_4P));
        if method == "init" {
            if self.engine.is_some() {
                return Err("ALREADY_INITIALIZED");
            }
            if p["protocolVersion"] != 1
                || p["sourceCommit"] != SOURCE
                || p["modelHash"] != model_hash
            {
                return Err("ENGINE_VERSION_MISMATCH");
            }
            self.engine = Some(defaults::engine(4, 0).map_err(|_| "MODEL_LOAD_FAILED")?);
            self.epoch = Some(epoch.to_owned());
            return Ok(
                json!({"engineVersion":SOURCE,"modelHash":model_hash,"rules":["tenhou-default-probe-only","majsoul-friend-east-3-red"],"productionReady":false}),
            );
        }
        let engine = self.engine.as_mut().ok_or("ENGINE_NOT_INITIALIZED")?;
        if method == "shutdown" {
            return Ok(json!({"stopped":true}));
        }
        if method == "reset" {
            let seat = p["ownSeat"]
                .as_u64()
                .filter(|v| *v < 4)
                .ok_or("INVALID_SEAT")?;
            let hand = p["handId"].as_str().ok_or("INVALID_HAND")?;
            if p["rules"] != "tenhou-default-probe-only" && p["rules"] != "majsoul-friend-east-3-red" {
                return Err("UNSUPPORTED_RULES");
            }
            self.friend_east = p["rules"] == "majsoul-friend-east-3-red";
            engine.reset();
            engine.set_seat(seat as u8);
            self.events.clear();
            self.hand = Some(hand.to_owned());
            return Ok(json!({"cursor":0}));
        }
        if self.hand.as_deref() != r["scope"]["handId"].as_str() || self.hand.is_none() {
            return Err("ENGINE_HAND_MISMATCH");
        }
        let cursor = p["expectedCursor"].as_u64().ok_or("INVALID_CURSOR")? as usize;
        if method == "advance" || method == "replay" {
            let batch = p["events"].as_array().ok_or("INVALID_EVENTS")?;
            if cursor > self.events.len() {
                return Err("ENGINE_CURSOR_MISMATCH");
            }
            if cursor.saturating_add(batch.len()) > 4096 {
                return Err("ENGINE_HISTORY_LIMIT");
            }
            let mut new_events = Vec::new();
            for (i, item) in batch.iter().enumerate() {
                if item["index"].as_u64() != Some((cursor + i + 1) as u64)
                    || item["sourceEventId"].as_str().is_none()
                {
                    return Err("ENGINE_CURSOR_MISMATCH");
                }
                let encoded = item.to_string();
                if cursor + i < self.events.len() {
                    if self.events[cursor + i] != encoded {
                        return Err("ENGINE_CURSOR_MISMATCH");
                    }
                } else {
                    let ev = mjai_compat::parse_line(&item["mjai"].to_string(), 4)
                        .ok_or("INVALID_MJAI_EVENT")?;
                    new_events.push((encoded, ev));
                }
            }
            for (encoded, ev) in new_events {
                engine.feed(ev);
                self.events.push(encoded);
            }
            return Ok(
                json!({"cursor":self.events.len(),"lastEventDigest":self.events.last().map(|s|format!("sha256:{:x}",Sha256::digest(s.as_bytes())))}),
            );
        }
        if method == "decide" {
            if cursor != self.events.len() {
                return Err("ENGINE_CURSOR_MISMATCH");
            }
            let version = p["stateVersion"].as_u64().ok_or("INVALID_STATE_VERSION")?;
            let hash = p["snapshotHash"]
                .as_str()
                .filter(|s| {
                    s.len() == 71
                        && s.starts_with("sha256:")
                        && s[7..].bytes().all(|b| b.is_ascii_hexdigit())
                })
                .ok_or("INVALID_SNAPSHOT_HASH")?;
            let decision = engine
                .decide()
                .map_err(|_| "ENGINE_INFERENCE_FAILED")?
                .ok_or("NO_LEGAL_ACTION")?;
            let selected = match decision.action {
                BotAction::Reach { pai } if self.friend_east => {
                    json!({"kind":"riichi-discard","tile":tile(&pai)?})
                }
                other => advice(other)?,
            };
            return Ok(
                json!({"cursor":cursor,"stateVersion":version,"snapshotHash":hash,"advice":selected,"engineVersion":SOURCE,"modelHash":model_hash}),
            );
        }
        Err("UNSUPPORTED_METHOD")
    }
}
fn main() {
    let mut runner = Runner {
        engine: None,
        epoch: None,
        hand: None,
        events: Vec::new(),
        friend_east: false,
    };
    let mut input = io::stdin().lock();
    loop {
        // Read at most MAX+1 bytes; never allocate an unbounded input line.
        let mut line = Vec::new();
        while line.len() <= MAX {
            let buf = match input.fill_buf() {
                Ok(b) => b,
                Err(_) => return,
            };
            if buf.is_empty() {
                break;
            }
            let n = buf
                .iter()
                .position(|b| *b == b'\n')
                .map(|i| i + 1)
                .unwrap_or(buf.len())
                .min(MAX + 1 - line.len());
            line.extend_from_slice(&buf[..n]);
            input.consume(n);
            if line.last() == Some(&b'\n') {
                break;
            }
        }
        if line.is_empty() {
            break;
        }
        if line.len() > MAX || line.last() != Some(&b'\n') {
            eprintln!("INVALID_FRAME");
            std::process::exit(2);
        }
        let r: Value = match serde_json::from_slice(&line) {
            Ok(v) => v,
            Err(_) => {
                eprintln!("INVALID_JSON");
                std::process::exit(2);
            }
        };
        if r["v"] != 1 || !r["id"].is_string() || !r["runnerEpoch"].is_string() {
            eprintln!("INVALID_PROTOCOL");
            std::process::exit(2);
        }
        let result = runner.call(&r);
        let mut response =
            json!({"v":1,"id":r["id"],"runnerEpoch":r["runnerEpoch"],"scope":r["scope"]});
        match result {
            Ok(value) => {
                response["ok"] = json!(true);
                response["result"] = value;
            }
            Err(code) => {
                response["ok"] = json!(false);
                response["error"] = json!({"code":code,"retryable":false});
            }
        }
        println!("{response}");
        if io::stdout().flush().is_err() {
            break;
        }
        if r["method"] == "shutdown" && response["ok"] == true {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserve_red_and_meld_parameters_reject_incomplete_riichi() {
        assert_eq!(
            advice(BotAction::Dahai {
                pai: "5mr".into(),
                tsumogiri: false
            })
            .unwrap()["tile"],
            "5mr"
        );
        assert_eq!(tile("E").unwrap(), "1z");
        let pon = advice(BotAction::Pon {
            target: 2,
            pai: "5m".into(),
            consumed: vec!["5mr".into(), "5m".into()],
        })
        .unwrap();
        assert_eq!(pon["fromSeat"], 2);
        assert_eq!(pon["consumed"], json!(["5mr", "5m"]));
        assert_eq!(
            advice(BotAction::Reach { pai: "5m".into() }),
            Err("INCOMPLETE_ENGINE_ACTION")
        );
        assert_eq!(
            advice(BotAction::Hora { target: 0 }),
            Err("UNSUPPORTED_ENGINE_ACTION")
        );
    }
}
