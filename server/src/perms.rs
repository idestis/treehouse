//! Role checks from spec §2, one function per permission. Handlers call these;
//! the client hiding a button is never the check.

use std::{fmt, str::FromStr};

use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Member,
    Moderator,
    Admin,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Member => "member",
            Role::Moderator => "moderator",
            Role::Admin => "admin",
        }
    }
}

impl fmt::Display for Role {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Role {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "member" => Ok(Role::Member),
            "moderator" => Ok(Role::Moderator),
            "admin" => Ok(Role::Admin),
            other => anyhow::bail!("unknown role {other:?}"),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Actor {
    pub id: i64,
    pub role: Role,
    pub is_owner: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Denied;

impl From<Denied> for AppError {
    fn from(_: Denied) -> Self {
        AppError::forbidden("not_allowed", "You can't do that.")
    }
}

/// Moderators act on members only; admins act on members and moderators;
/// only the owner acts on other admins.
pub fn can_act_on(actor: Actor, target_role: Role) -> Result<(), Denied> {
    match (actor.role, target_role) {
        (Role::Admin, Role::Admin) if actor.is_owner => Ok(()),
        (Role::Admin, Role::Member | Role::Moderator) => Ok(()),
        (Role::Moderator, Role::Member) => Ok(()),
        _ => Err(Denied),
    }
}

/// Authors delete their own; moderators and admins delete per `can_act_on`.
pub fn can_delete_message(actor: Actor, author_id: i64, author_role: Role) -> Result<(), Denied> {
    if actor.id == author_id {
        return Ok(());
    }
    can_act_on(actor, author_role)
}

/// Admins always; moderators only when the treehouse allows it.
pub fn can_manage_invites(actor: Actor, mods_can_invite: bool) -> Result<(), Denied> {
    match actor.role {
        Role::Admin => Ok(()),
        Role::Moderator if mods_can_invite => Ok(()),
        _ => Err(Denied),
    }
}

/// Invites start people as members, or moderators when an admin makes them.
pub fn can_invite_as(actor: Actor, role: Role) -> Result<(), Denied> {
    match role {
        Role::Member => Ok(()),
        Role::Moderator if actor.role == Role::Admin => Ok(()),
        _ => Err(Denied),
    }
}

/// Rooms (create, rename, resize, delete) are admin-only (spec §2).
pub fn can_manage_rooms(actor: Actor) -> Result<(), Denied> {
    if actor.role == Role::Admin {
        Ok(())
    } else {
        Err(Denied)
    }
}

/// Two-step sign-in is mandatory for admins, and for moderators when the
/// treehouse turns that on.
pub fn mfa_required(role: Role, mods_require_mfa: bool) -> bool {
    role == Role::Admin || (role == Role::Moderator && mods_require_mfa)
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn a(role: Role, is_owner: bool) -> Actor {
        Actor {
            id: 1,
            role,
            is_owner,
        }
    }

    #[test]
    fn hierarchy() {
        assert!(can_act_on(a(Role::Moderator, false), Role::Member).is_ok());
        assert_eq!(
            can_act_on(a(Role::Moderator, false), Role::Moderator),
            Err(Denied)
        );
        assert!(can_act_on(a(Role::Admin, false), Role::Moderator).is_ok());
        assert_eq!(can_act_on(a(Role::Admin, false), Role::Admin), Err(Denied));
        assert!(can_act_on(a(Role::Admin, true), Role::Admin).is_ok());
        assert_eq!(
            can_act_on(a(Role::Member, false), Role::Member),
            Err(Denied)
        );
    }

    #[test]
    fn deleting() {
        assert!(can_delete_message(a(Role::Member, false), 1, Role::Admin).is_ok());
        assert_eq!(
            can_delete_message(a(Role::Member, false), 2, Role::Member),
            Err(Denied)
        );
        assert!(can_delete_message(a(Role::Moderator, false), 2, Role::Member).is_ok());
    }

    #[test]
    fn invites() {
        assert!(can_manage_invites(a(Role::Admin, false), false).is_ok());
        assert_eq!(
            can_manage_invites(a(Role::Moderator, false), false),
            Err(Denied)
        );
        assert!(can_manage_invites(a(Role::Moderator, false), true).is_ok());
        assert_eq!(
            can_invite_as(a(Role::Moderator, false), Role::Moderator),
            Err(Denied)
        );
        assert_eq!(
            can_invite_as(a(Role::Admin, false), Role::Admin),
            Err(Denied)
        );
    }
}
