#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_private_keys_and_malformed_certificates() {
        for pem in [
            "",
            "not a certificate",
            "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----",
        ] {
            assert!(certificate_metadata(pem).is_err());
        }
    }

    #[test]
    fn accepts_only_literal_loopback_bridge_endpoints() {
        for host in ["127.0.0.1", "127.0.0.2", "::1"] {
            assert!(validate_loopback(host).is_ok());
        }
        for host in [
            "localhost",
            "192.168.1.1",
            "example.com",
            "127.0.0.1.example.com",
            "0.0.0.0",
        ] {
            assert!(validate_loopback(host).is_err());
        }
    }
    #[test]
    fn validates_certificate_lifetime_and_fingerprint() {
        let Ok(path) = std::env::var("POSTAL_SNAP_MAIL_TEST_CA_CERT") else {
            return;
        };
        let pem = std::fs::read_to_string(path).unwrap();
        let metadata = certificate_metadata(&pem).unwrap();
        assert_eq!(metadata.fingerprint.len(), 95);
        assert!(!metadata.expires_at.is_empty());
        assert!(certificate_metadata(&(pem + "\n-----BEGIN PRIVATE KEY-----")).is_err());
    }
}

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateMetadata {
    pub reference: String,
    pub fingerprint: String,
    pub expires_at: String,
}

struct PendingCertificate {
    pem: String,
    approved: bool,
    created: Instant,
}

static PENDING: OnceLock<Mutex<HashMap<String, PendingCertificate>>> = OnceLock::new();

pub fn validate_loopback(host: &str) -> Result<(), String> {
    if host
        .parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.is_loopback())
    {
        Ok(())
    } else {
        Err("Only literal loopback addresses are supported for Proton Bridge.".into())
    }
}

pub fn describe_certificate(pem: &str) -> Result<CertificateMetadata, String> {
    if pem.len() > 65536
        || pem.contains("PRIVATE KEY")
        || !pem.trim_start().starts_with("-----BEGIN CERTIFICATE-----")
    {
        return Err("Choose a public PEM certificate, without a private key.".into());
    }
    let (remaining, decoded) = x509_parser::pem::parse_x509_pem(pem.as_bytes())
        .map_err(|_| "The selected certificate is invalid.".to_string())?;
    if decoded.label != "CERTIFICATE" || remaining.iter().any(|byte| !byte.is_ascii_whitespace()) {
        return Err("Choose one public PEM certificate.".into());
    }
    let certificate = decoded
        .parse_x509()
        .map_err(|_| "The selected certificate is invalid.".to_string())?;
    let expires = chrono::DateTime::from_timestamp(certificate.validity().not_after.timestamp(), 0)
        .ok_or("The certificate expiry is invalid.")?
        .to_rfc3339();
    let fingerprint = Sha256::digest(&decoded.contents)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":");
    Ok(CertificateMetadata {
        reference: String::new(),
        fingerprint,
        expires_at: expires,
    })
}

pub fn certificate_metadata(pem: &str) -> Result<CertificateMetadata, String> {
    let metadata = describe_certificate(pem)?;
    let (_, decoded) = x509_parser::pem::parse_x509_pem(pem.as_bytes())
        .map_err(|_| "The selected certificate is invalid.".to_string())?;
    let certificate = decoded
        .parse_x509()
        .map_err(|_| "The selected certificate is invalid.".to_string())?;
    if !certificate.validity().is_valid() {
        return Err("The selected certificate has expired or is not yet valid.".into());
    }
    Ok(metadata)
}

pub fn verify_peer_certificate(pem: &str, peer_der: &[u8]) -> Result<(), String> {
    let approved = certificate_metadata(pem)?;
    let presented = Sha256::digest(peer_der)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":");
    if approved.fingerprint != presented {
        return Err("Certificate verification failed. Bridge presented a different certificate. Import and approve its replacement.".into());
    }
    Ok(())
}

pub fn stage_certificate(pem: String) -> Result<CertificateMetadata, String> {
    let mut metadata = certificate_metadata(&pem)?;
    metadata.reference = uuid::Uuid::new_v4().to_string();
    let mut pending = PENDING
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "Certificate storage is unavailable.")?;
    pending.retain(|_, item| item.created.elapsed() < Duration::from_secs(600));
    if pending.len() >= 16 {
        return Err("Too many pending certificates. Try again later.".into());
    }
    pending.insert(
        metadata.reference.clone(),
        PendingCertificate {
            pem,
            approved: false,
            created: Instant::now(),
        },
    );
    Ok(metadata)
}

pub fn approve_pending(reference: &str) -> Result<(), String> {
    let mut pending = PENDING
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "Certificate storage is unavailable.")?;
    let item = pending
        .get_mut(reference)
        .ok_or("Certificate permission has expired. Import it again.")?;
    if item.created.elapsed() >= Duration::from_secs(600) {
        return Err("Certificate permission has expired. Import it again.".into());
    }
    certificate_metadata(&item.pem)?;
    item.approved = true;
    Ok(())
}

pub fn approved_pem(reference: &str) -> Result<String, String> {
    let pending = PENDING
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "Certificate storage is unavailable.")?;
    let item = pending
        .get(reference)
        .filter(|item| item.approved && item.created.elapsed() < Duration::from_secs(600))
        .ok_or("Certificate permission has expired. Import and approve it again.")?;
    certificate_metadata(&item.pem)?;
    Ok(item.pem.clone())
}

pub fn consume(reference: &str) {
    if let Ok(mut pending) = PENDING.get_or_init(Mutex::default).lock() {
        pending.remove(reference);
    }
}

pub fn apply_setup_trust(
    request: &crate::models::AccountSetupRequest,
    imap: &mut crate::models::ServerConfig,
    smtp: &mut crate::models::ServerConfig,
) -> Result<(), String> {
    if let Some(reference) = &request.certificate_reference {
        if request.provider != crate::models::ProviderKind::ProtonBridge {
            return Err("Only Proton Bridge accounts can trust a local certificate.".into());
        }
        validate_loopback(&imap.host)?;
        validate_loopback(&smtp.host)?;
        let pem = approved_pem(reference)?;
        imap.trusted_certificate = Some(pem.clone());
        smtp.trusted_certificate = Some(pem);
    }
    Ok(())
}

pub fn tls_error(error: &impl std::fmt::Display, action: &str) -> String {
    let detail = error.to_string().to_ascii_lowercase();
    if detail.contains("certificate")
        || detail.contains("unknown issuer")
        || detail.contains("not trusted")
    {
        "Certificate verification failed. Import the correct public Bridge certificate or repair server trust.".into()
    } else {
        crate::security::redact_error(error, action)
    }
}
