import "@ate/ui/base.css";
import "./styles.css";

// Everything here is progressive enhancement: the page works without JS. No network calls, no storage.

const WAITLIST_TO = "hello@flowverse.cloud";

// Mobile menu
const toggle = document.querySelector<HTMLButtonElement>(".nav-toggle");
const links = document.getElementById("nav-links");
if (toggle && links) {
  const setOpen = (open: boolean) => {
    toggle.setAttribute("aria-expanded", String(open));
    links.classList.toggle("open", open);
  };
  toggle.addEventListener("click", () => setOpen(toggle.getAttribute("aria-expanded") !== "true"));
  links.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("a")) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && links.classList.contains("open")) {
      setOpen(false);
      toggle.focus();
    }
  });
}

// Waitlist: client-side only. Builds a mailto: link and hands it to the user's mail app.
const form = document.getElementById("wait") as HTMLFormElement | null;
const email = document.getElementById("wait-email") as HTMLInputElement | null;
const status = document.getElementById("wait-status");
if (form && email && status) {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!email.checkValidity()) {
      email.reportValidity();
      return;
    }
    const subject = "Flow mainnet waitlist";
    const body = `Please email me at ${email.value.trim()} when Flow is live on mainnet.`;
    window.location.href = `mailto:${WAITLIST_TO}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    status.textContent = "Your email app should open with the note ready to send.";
  });
}
