//! NaCl `box` (X25519 + XSalsa20-Poly1305) via `crypto_box::SalsaBox`, wire-compatible with
//! tweetnacl's `nacl.box`. Sealed values are `{n: b64 nonce, c: b64 ciphertext}`.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use crypto_box::aead::{Aead, AeadCore, OsRng};
use crypto_box::{PublicKey, SalsaBox, SecretKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

pub fn b64u(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn unb64(s: &str) -> Result<Vec<u8>, String> {
    STANDARD.decode(s.trim()).map_err(|e| format!("bad base64: {e}"))
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    use rand_core::RngCore;
    let mut b = [0u8; N];
    OsRng.fill_bytes(&mut b);
    b
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Sealed {
    pub n: String,
    pub c: String,
}

/// Orbit's long-lived keypair, persisted as `{secret, public}` (both b64) under `remote_keypair`.
#[derive(Clone)]
pub struct Keypair {
    secret: [u8; 32],
    public: [u8; 32],
}

impl Keypair {
    pub fn generate() -> Self {
        let sk = SecretKey::generate(&mut OsRng);
        Self::from_secret(sk.to_bytes())
    }

    pub fn from_secret(secret: [u8; 32]) -> Self {
        let public = *PublicKey::from(&SecretKey::from_bytes(secret)).as_bytes();
        Self { secret, public }
    }

    pub fn public(&self) -> [u8; 32] {
        self.public
    }

    pub fn to_json(&self) -> String {
        serde_json::json!({ "secret": b64(&self.secret), "public": b64(&self.public) }).to_string()
    }

    pub fn from_json(s: &str) -> Option<Self> {
        let v: Value = serde_json::from_str(s).ok()?;
        let secret: [u8; 32] = unb64(v.get("secret")?.as_str()?).ok()?.try_into().ok()?;
        Some(Self::from_secret(secret))
    }

    fn salsa(&self, peer: &[u8; 32]) -> SalsaBox {
        SalsaBox::new(&PublicKey::from(*peer), &SecretKey::from_bytes(self.secret))
    }

    pub fn seal(&self, peer: &[u8; 32], plaintext: &[u8]) -> Sealed {
        let nonce = SalsaBox::generate_nonce(&mut OsRng);
        let c = self.salsa(peer).encrypt(&nonce, plaintext).expect("encryption cannot fail");
        Sealed { n: b64(&nonce), c: b64(&c) }
    }

    pub fn seal_json(&self, peer: &[u8; 32], v: &Value) -> Sealed {
        self.seal(peer, v.to_string().as_bytes())
    }

    pub fn open(&self, peer: &[u8; 32], sealed: &Sealed) -> Result<Vec<u8>, String> {
        let n = unb64(&sealed.n)?;
        if n.len() != 24 {
            return Err("bad nonce length".into());
        }
        let c = unb64(&sealed.c)?;
        self.salsa(peer).decrypt(n.as_slice().into(), c.as_slice()).map_err(|_| "decryption failed".to_string())
    }

    pub fn open_json(&self, peer: &[u8; 32], sealed: &Sealed) -> Result<Value, String> {
        serde_json::from_slice(&self.open(peer, sealed)?).map_err(|e| format!("bad json: {e}"))
    }
}

pub fn parse_pk(s: &str) -> Result<[u8; 32], String> {
    unb64(s)?.try_into().map_err(|_| "public key must be 32 bytes".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Produced with tweetnacl (`nacl.box.keyPair.fromSecretKey`, secrets 0x11*32 / 0x22*32, nonce 0x33*24):
    // nacl.box(msg, nonce, orbitPk, deviceSk).
    const ORBIT_PK: &str = "e06Qm75//kTEZaIgA31gjuNYl9Me+XLwf3SJLLD3PxM=";
    const DEVICE_PK: &str = "D6poTtKIZ7l/Smot7l34zpdOdrcBjj8iocTPJnhXDyA=";
    const NONCE: &str = "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMz";
    const CIPHER: &str = "2/biFU+Vk93iC53QzowqoU0+uruEy58sw5A3AfCQ5H/MOxO3lHK5ygzjtPXsfZ0nmdM/h/jfejOmd2Rzu7tudrC/";
    const MSG: &str = r#"{"t":"rpc","id":1,"method":"snapshot","params":{}}"#;

    #[test]
    fn public_keys_match_tweetnacl() {
        assert_eq!(b64(&Keypair::from_secret([0x11; 32]).public()), ORBIT_PK);
        assert_eq!(b64(&Keypair::from_secret([0x22; 32]).public()), DEVICE_PK);
    }

    #[test]
    fn decrypts_tweetnacl_vector() {
        let orbit = Keypair::from_secret([0x11; 32]);
        let sealed = Sealed { n: NONCE.into(), c: CIPHER.into() };
        let plain = orbit.open(&parse_pk(DEVICE_PK).unwrap(), &sealed).unwrap();
        assert_eq!(String::from_utf8(plain).unwrap(), MSG);
    }

    #[test]
    fn encrypts_to_tweetnacl_vector() {
        // Same keys + nonce must give the same bytes as tweetnacl (checks the sender direction too).
        let device = Keypair::from_secret([0x22; 32]);
        let nonce = crypto_box::Nonce::from([0x33u8; 24]);
        let c = device.salsa(&parse_pk(ORBIT_PK).unwrap()).encrypt(&nonce, MSG.as_bytes()).unwrap();
        assert_eq!(b64(&c), CIPHER);
    }

    #[test]
    fn round_trips_and_rejects_tampering() {
        let (a, b) = (Keypair::generate(), Keypair::generate());
        let sealed = a.seal_json(&b.public(), &serde_json::json!({ "hello": "world" }));
        assert_eq!(b.open_json(&a.public(), &sealed).unwrap()["hello"], "world");
        // Nonces differ per message.
        assert_ne!(sealed.n, a.seal(&b.public(), b"x").n);
        // Wrong peer key, tampered ciphertext, and bad nonce all fail.
        assert!(b.open(&Keypair::generate().public(), &sealed).is_err());
        let mut bad = sealed.clone();
        bad.c = b64(&[1, 2, 3]);
        assert!(b.open(&a.public(), &bad).is_err());
        bad = sealed.clone();
        bad.n = b64(&[0; 5]);
        assert!(b.open(&a.public(), &bad).is_err());
    }

    #[test]
    fn keypair_persists_through_json() {
        let k = Keypair::generate();
        let again = Keypair::from_json(&k.to_json()).unwrap();
        assert_eq!(k.public(), again.public());
        assert!(Keypair::from_json("nope").is_none());
    }

    #[test]
    fn base64url_has_no_padding() {
        assert_eq!(b64u(&[0xfb, 0xff]), "-_8");
    }
}
