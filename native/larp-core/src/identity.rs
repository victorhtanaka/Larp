use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{pkcs8::DecodePrivateKey, pkcs8::DecodePublicKey, Signature, Signer, SigningKey, VerifyingKey};
use zeroize::Zeroize;

use crate::error::CoreError;

const MAX_PRIVATE_PEM_BYTES: usize = 4 * 1024;
const MAX_PUBLIC_PEM_BYTES: usize = 4 * 1024;
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const SIGNATURE_BYTES: usize = 64;
const MAX_SIGNATURE_BASE64_BYTES: usize = 4 * ((SIGNATURE_BYTES + 2) / 3);


fn validate_pem(pem: &str, max_bytes: usize, label: &str) -> Result<(), CoreError> {
    if pem.len() > max_bytes {
        return Err(CoreError::InputTooLarge);
    }
    let begin = format!("-----BEGIN {label}-----\n");
    let end = format!("\n-----END {label}-----\n");
    if !pem.starts_with(&begin)
        || !pem.ends_with(&end)
        || pem.matches("-----BEGIN ").count() != 1
        || pem.matches("-----END ").count() != 1
        || !pem.is_ascii()
    {
        return Err(CoreError::InvalidIdentity);
    }
    Ok(())
}


fn decode_base64(encoded: &str) -> Result<Vec<u8>, CoreError> {
    let decoded = STANDARD.decode(encoded).map_err(|_| CoreError::InvalidIdentity)?;
    if STANDARD.encode(&decoded) != encoded {
        return Err(CoreError::InvalidIdentity);
    }
    Ok(decoded)
}
pub fn generate_keypair() -> Result<(String, String), CoreError> {
    use ed25519_dalek::pkcs8::{EncodePrivateKey, EncodePublicKey, spki::der::pem::LineEnding};
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).map_err(|_| CoreError::Internal)?;
    let key = SigningKey::from_bytes(&seed);
    seed.zeroize();
    let private = key.to_pkcs8_pem(LineEnding::LF).map_err(|_| CoreError::InvalidIdentity)?.to_string();
    let public = key.verifying_key().to_public_key_pem(LineEnding::LF).map_err(|_| CoreError::InvalidIdentity)?;
    Ok((private, public))
}

pub fn derive_public_key(private_pem: &str) -> Result<String, CoreError> {
    use ed25519_dalek::pkcs8::EncodePublicKey;
    validate_pem(private_pem, MAX_PRIVATE_PEM_BYTES, "PRIVATE KEY")?;
    let key = SigningKey::from_pkcs8_pem(private_pem).map_err(|_| CoreError::InvalidIdentity)?;
    key.verifying_key().to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
        .map_err(|_| CoreError::InvalidIdentity)
}
pub fn validate_public_pem(public_pem: &str) -> Result<(), CoreError> {
    validate_pem(public_pem, MAX_PUBLIC_PEM_BYTES, "PUBLIC KEY")?;
    VerifyingKey::from_public_key_pem(public_pem).map_err(|_| CoreError::InvalidIdentity)?;
    Ok(())
}

pub fn sign_pem(private_pem: &str, message: &[u8]) -> Result<String, CoreError> {
    if message.len() > MAX_MESSAGE_BYTES { return Err(CoreError::InputTooLarge); }
    validate_pem(private_pem, MAX_PRIVATE_PEM_BYTES, "PRIVATE KEY")?;
    let key = SigningKey::from_pkcs8_pem(private_pem).map_err(|_| CoreError::InvalidIdentity)?;
    Ok(STANDARD.encode(key.sign(message).to_bytes()))
}

pub fn verify_strict_pem(public_pem: &str, message: &[u8], signature_base64: &str) -> Result<bool, CoreError> {
    if message.len() > MAX_MESSAGE_BYTES { return Err(CoreError::InputTooLarge); }
    if signature_base64.len() > MAX_SIGNATURE_BASE64_BYTES {
        return Err(CoreError::InputTooLarge);
    }
    validate_pem(public_pem, MAX_PUBLIC_PEM_BYTES, "PUBLIC KEY")?;
    let key = VerifyingKey::from_public_key_pem(public_pem).map_err(|_| CoreError::InvalidIdentity)?;
    let bytes = decode_base64(signature_base64)?;
    if bytes.len() != SIGNATURE_BYTES { return Ok(false); }
    let signature = Signature::from_slice(&bytes).map_err(|_| CoreError::InvalidIdentity)?;
    Ok(key.verify_strict(message, &signature).is_ok())
}


#[cfg(test)]
mod tests {
    use super::*;

    const PRIVATE_PEM: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g\n-----END PRIVATE KEY-----\n";
    const PUBLIC_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=\n-----END PUBLIC KEY-----\n";
    const RFC8032_EMPTY_SIGNATURE: &str = "5VZDAMNgrHKQhuLMgG6CioSHfx645dl02HPgZSJJAVVfuIIVkKM7rMYeOXAc+bRr0lv18FlbviRlUUFDjnoQCw==";

    #[test]
    fn signs_and_verifies_node_compatible_rfc8032_signature_bytes() {
        let signature = sign_pem(PRIVATE_PEM, b"").unwrap();
        assert_eq!(signature, RFC8032_EMPTY_SIGNATURE);
        assert!(verify_strict_pem(PUBLIC_PEM, b"", &signature).unwrap());
    }

    #[test]
    fn verification_rejects_tampered_message_and_signature() {
        assert!(!verify_strict_pem(PUBLIC_PEM, b"a", RFC8032_EMPTY_SIGNATURE).unwrap());
        let mut changed = STANDARD.decode(RFC8032_EMPTY_SIGNATURE).unwrap();
        changed[0] ^= 1;
        assert!(!verify_strict_pem(PUBLIC_PEM, b"", &STANDARD.encode(changed)).unwrap());
    }

    #[test]
    fn rejects_malformed_keys_noncanonical_base64_and_oversized_signatures() {
        assert_eq!(sign_pem("not a PEM", b"").unwrap_err(), CoreError::InvalidIdentity);
        assert_eq!(verify_strict_pem(PUBLIC_PEM, b"", "%%%").unwrap_err(), CoreError::InvalidIdentity);
        assert_eq!(
            verify_strict_pem(PUBLIC_PEM, b"", &"A".repeat(MAX_SIGNATURE_BASE64_BYTES + 1)).unwrap_err(),
            CoreError::InputTooLarge,
        );
        let invalid_public = "-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----\n";
        assert_eq!(
            verify_strict_pem(invalid_public, b"", RFC8032_EMPTY_SIGNATURE).unwrap_err(),
            CoreError::InvalidIdentity,
        );
    }

    #[test]
    fn private_file_projection_signing_and_verification_are_deterministic() {
        use ed25519_dalek::pkcs8::{EncodePrivateKey, EncodePublicKey, spki::der::pem::LineEnding};
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let private = key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string();
        let public = key.verifying_key().to_public_key_pem(LineEnding::LF).unwrap();
        assert_eq!(derive_public_key(&private).unwrap(), public);
        let signature = sign_pem(&private, b"local invariant").unwrap();
        assert!(verify_strict_pem(&public, b"local invariant", &signature).unwrap());
        assert!(!verify_strict_pem(&public, b"different payload", &signature).unwrap());
    }
}
