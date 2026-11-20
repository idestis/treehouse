// Words used all over the app: buttons, roles, presence.
import type { Pack, UkPlural } from "../types";

export const en = {
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.close": "Close",
  "common.delete": "Delete",
  "common.done": "Done",
  "common.back": "Back",
  "common.continue": "Continue",
  "common.copy": "Copy",
  "common.copied": "Copied.",
  "common.tryAgain": "Try again",
  "common.saving": "Saving…",
  "common.saved": "Saved.",
  "common.loading": "Loading…",
  "common.you": "you",
  "common.theDeck": "The Deck",

  "role.member": "Member",
  "role.moderator": "Moderator",
  "role.admin": "Admin",
  "role.owner": "Owner",

  "presence.online": "Online",
  "presence.away": "Away",
  "presence.busy": "Busy",
  "presence.brb": "Be right back",
  "presence.offline": "Offline",

  "time.justNow": "just now",

  "tray.open": "Open Treehouse",
  "tray.settings": "Settings…",
  "tray.updates": "Check for updates…",
  "tray.quit": "Quit Treehouse",
  "shell.signInFirst": "Sign in first, then open settings.",
} as const;

export const es: Pack<typeof en> = {
  "common.cancel": "Cancelar",
  "common.save": "Guardar",
  "common.close": "Cerrar",
  "common.delete": "Borrar",
  "common.done": "Listo",
  "common.back": "Atrás",
  "common.continue": "Continuar",
  "common.copy": "Copiar",
  "common.copied": "Copiado.",
  "common.tryAgain": "Reintentar",
  "common.saving": "Guardando…",
  "common.saved": "Guardado.",
  "common.loading": "Cargando…",
  "common.you": "tú",
  "common.theDeck": "The Deck",

  "role.member": "Miembro",
  "role.moderator": "Moderador",
  "role.admin": "Admin",
  "role.owner": "Dueño",

  "presence.online": "En línea",
  "presence.away": "Ausente",
  "presence.busy": "Ocupado",
  "presence.brb": "Vuelvo enseguida",
  "presence.offline": "Desconectado",

  "time.justNow": "ahora mismo",

  "tray.open": "Abrir Treehouse",
  "tray.settings": "Ajustes…",
  "tray.updates": "Buscar actualizaciones…",
  "tray.quit": "Salir de Treehouse",
  "shell.signInFirst": "Entra primero y luego abre los ajustes.",
};

export const uk: Pack<typeof en, UkPlural> = {
  "common.cancel": "Скасувати",
  "common.save": "Зберегти",
  "common.close": "Закрити",
  "common.delete": "Видалити",
  "common.done": "Готово",
  "common.back": "Назад",
  "common.continue": "Далі",
  "common.copy": "Копіювати",
  "common.copied": "Скопійовано.",
  "common.tryAgain": "Спробувати ще",
  "common.saving": "Зберігаю…",
  "common.saved": "Збережено.",
  "common.loading": "Завантаження…",
  "common.you": "ти",
  "common.theDeck": "The Deck",

  "role.member": "Учасник",
  "role.moderator": "Модератор",
  "role.admin": "Адмін",
  "role.owner": "Власник",

  "presence.online": "У мережі",
  "presence.away": "Відійшов",
  "presence.busy": "Зайнятий",
  "presence.brb": "Скоро повернусь",
  "presence.offline": "Не в мережі",

  "time.justNow": "щойно",

  "tray.open": "Відкрити Treehouse",
  "tray.settings": "Налаштування…",
  "tray.updates": "Перевірити оновлення…",
  "tray.quit": "Вийти з Treehouse",
  "shell.signInFirst": "Спершу увійди, потім відкрий налаштування.",
};
