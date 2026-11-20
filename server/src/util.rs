use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{Rng, RngCore};
use sha2::{Digest, Sha256};

/// 256-bit random token for sessions and two-step challenges.
pub fn new_token() -> String {
    let mut b = [0u8; 32];
    rand::rng().fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

/// Only SHA-256 hashes of tokens and codes are stored.
pub fn sha256(s: &str) -> Vec<u8> {
    Sha256::digest(s.as_bytes()).to_vec()
}

/// No 0/O/1/I/L, so codes survive being read aloud or typed from a phone.
const CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";

fn code_part(n: usize) -> String {
    let mut rng = rand::rng();
    (0..n)
        .map(|_| CODE_ALPHABET[rng.random_range(0..CODE_ALPHABET.len())] as char)
        .collect()
}

/// Invite code: XXXXX-XXXXX.
pub fn invite_code() -> String {
    format!("{}-{}", code_part(5), code_part(5))
}

/// Backup code: xxxx-xxxx (lowercase, easy to read).
pub fn backup_code() -> String {
    format!("{}-{}", code_part(4), code_part(4)).to_lowercase()
}

/// Accept codes typed with spaces, lowercase or without the dash.
pub fn normalize_code(input: &str, group: usize) -> String {
    let clean: String = input
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if clean.len() == group * 2 {
        format!("{}-{}", &clean[..group], &clean[group..])
    } else {
        clean
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_normalize() {
        assert_eq!(normalize_code(" 8xx9w 33kqc ", 5), "8XX9W-33KQC");
        assert_eq!(normalize_code("8XX9W-33KQC", 5), "8XX9W-33KQC");
        let c = invite_code();
        assert_eq!(normalize_code(&c.to_lowercase(), 5), c);
    }
}
