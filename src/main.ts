// DuoPulse M0 — UI-полоса спайка: адресная строка-заглушка.
// Ввод URL/запроса → команда navigate в Rust → дочерний webview "content".
import { invoke } from "@tauri-apps/api/core";
import "./style.css";

const omnibox = document.getElementById("omnibox") as HTMLInputElement;

// Заглушка omnibox: URL как есть, «похоже на домен» — https://,
// прочее — поисковый запрос YouTube (спайк про YouTube).
function normalize(input: string): string {
  const t = input.trim();
  if (!t) return "";
  if (/^(https?:\/\/|file:\/\/|about:)/i.test(t)) return t;
  if (/^[\w-]+(\.[\w-]+)+([\/?#].*)?$/.test(t)) return "https://" + t;
  return "https://www.youtube.com/results?search_query=" + encodeURIComponent(t);
}

async function nav(): Promise<void> {
  const url = normalize(omnibox.value);
  if (!url) return;
  try {
    await invoke("navigate", { url });
  } catch (e) {
    console.error("navigate failed:", e);
  }
}

omnibox.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void nav();
});
document.getElementById("go")?.addEventListener("click", () => void nav());
document.getElementById("back")?.addEventListener("click", () => void invoke("go_back").catch(console.error));
document.getElementById("fwd")?.addEventListener("click", () => void invoke("go_forward").catch(console.error));
document.getElementById("reload")?.addEventListener("click", () => void invoke("reload").catch(console.error));
