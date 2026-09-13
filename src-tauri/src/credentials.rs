use keyring::Entry;
use zeroize::Zeroizing;

const SERVICE: &str = "run.rosie.snap.mail";

pub fn store(account_id: &str, password: &str) -> Result<(), String> {
    entry(account_id)?
        .set_password(password)
        .map_err(|_| "The system password vault could not save this account.".into())
}

pub fn load(account_id: &str) -> Result<Zeroizing<String>, String> {
    let entry = entry(account_id)?;
    let password = entry.get_password().map_err(|_| {
        "The password is unavailable. Remove and add this account again.".to_string()
    })?;
    #[cfg(target_os = "windows")]
    ensure_windows_local_persistence(account_id, &password);
    Ok(Zeroizing::new(password))
}

pub fn load_for_removal(account_id: &str) -> Result<Option<Zeroizing<String>>, String> {
    match entry(account_id)?.get_password() {
        Ok(password) => Ok(Some(Zeroizing::new(password))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("The system password vault is unavailable.".into()),
    }
}

pub fn remove(account_id: &str) -> Result<(), String> {
    match entry(account_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("The system password vault could not remove this account.".into()),
    }
}

fn entry(account_id: &str) -> Result<Entry, String> {
    let id = uuid::Uuid::parse_str(account_id)
        .map_err(|_| "The account password store is invalid.".to_string())?;
    let user = id.hyphenated().to_string();
    #[cfg(target_os = "windows")]
    {
        windows_local_entry(&user)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Entry::new(SERVICE, &user).map_err(|_| "The system password vault is unavailable.".into())
    }
}

/// Keep Windows credentials device-scoped (`CRED_PERSIST_LOCAL_MACHINE`).
/// The mail database and attachments live in LocalAppData, so a roamed
/// credential would outlive its account data and follow the user to machines
/// that no longer have the account. Local persistence is still per-user and
/// DPAPI-encrypted; it is not machine-wide.
#[cfg(target_os = "windows")]
fn windows_local_entry(user: &str) -> Result<Entry, String> {
    let modifiers = std::collections::HashMap::from([("persistence", "local")]);
    let inner = keyring_core::Entry::new_with_modifiers(SERVICE, user, &modifiers)
        .map_err(|_| "The system password vault is unavailable.".to_string())?;
    Ok(Entry { inner })
}

/// Existing installs may hold Enterprise-persisted credentials created before
/// the local-only store decision. Rewrite the secret once per account/process
/// so it stops roaming; failures are best effort because the credential still
/// works on this machine.
#[cfg(target_os = "windows")]
fn ensure_windows_local_persistence(account_id: &str, password: &str) {
    use std::sync::{Mutex, OnceLock};

    static CHECKED: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    let checked = CHECKED.get_or_init(|| Mutex::new(std::collections::HashSet::new()));
    let Ok(mut checked) = checked.lock() else {
        return;
    };
    if !checked.insert(account_id.to_string()) {
        return;
    }
    drop(checked);

    let id = match uuid::Uuid::parse_str(account_id) {
        Ok(id) => id,
        Err(_) => return,
    };
    let Ok(entry) = windows_local_entry(&id.hyphenated().to_string()) else {
        return;
    };
    let Ok(attributes) = entry.inner.get_attributes() else {
        return;
    };
    let is_local = attributes
        .get("persistence")
        .is_some_and(|value| value.eq_ignore_ascii_case("local"));
    if !is_local {
        let _ = entry.inner.set_password(password);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The Windows entry is cfg-gated, so compile-check its exact construction
    // shape on every host. Running on a host with a default store may succeed
    // or fail depending on the store; no assertion beyond construction.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn windows_local_persistence_entry_shape_compiles() {
        let modifiers = std::collections::HashMap::from([("persistence", "local")]);
        if let Ok(inner) =
            keyring_core::Entry::new_with_modifiers(SERVICE, "shape-check", &modifiers)
        {
            let entry = Entry { inner };
            let _ = entry.inner.get_attributes();
            let _ = entry.inner.set_password("shape-check");
        }
    }
}
