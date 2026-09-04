use keyring::Entry;
use zeroize::Zeroizing;

const SERVICE: &str = "run.rosie.snap.mail";

pub fn store(account_id: &str, password: &str) -> Result<(), String> {
    entry(account_id)?
        .set_password(password)
        .map_err(|_| "The system password vault could not save this account.".into())
}

pub fn load(account_id: &str) -> Result<Zeroizing<String>, String> {
    entry(account_id)?
        .get_password()
        .map(Zeroizing::new)
        .map_err(|_| "The password is unavailable. Remove and add this account again.".into())
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
    Entry::new(SERVICE, &id.hyphenated().to_string())
        .map_err(|_| "The system password vault is unavailable.".into())
}
