//! Shared data types and validation for the native IPC boundary.

mod dto;
mod folder_role;
mod ipc_error;
mod validate;

#[cfg(test)]
mod tests;

pub use dto::*;
pub use folder_role::*;
pub use ipc_error::*;
pub use validate::*;
