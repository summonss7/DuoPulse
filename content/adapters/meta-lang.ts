// Детект языка текстов метаданных видео (duopulse-221): последний резерв
// originalLangsOf (youtube.ts) для видео без сигналов языка у платформы —
// музыка с ручными дорожками без asr и одиночным звуком отдаёт НИЧЕГО
// (пробы 23.11.2026: Mylène Farmer Uhi00MoqpNg — captionTracks en+fr manual,
// ни audioTracks[].original (web/ANDROID/IOS/TV), ни originalLanguage, ни
// audioTrackId, ни языка у аудио-форматов/DASH). Автор пишет название и
// описание на языке контента — скоринг по стоп-словам, жанровым маркерам и
// диакритике даёт язык, который сверяется с языком имеющихся дорожек.
// Чистая функция без зависимостей и сети, детерминированная.

/** Поля videoDetails player-ответа (все unknown — чужой JSON). */
export interface MetaLangTexts {
  title?: unknown;
  author?: unknown;
  shortDescription?: unknown;
}

/** Служебные слова, вес 1: пересечения языков («la», «en», «de») дают очки
 * каждому — гасятся отрывом победителя, уникальные решают. */
const FUNCTION_WORDS: Record<string, readonly string[]> = {
  en: ["the", "and", "of", "to", "in", "is", "for", "with", "on", "you", "your", "we", "our", "this", "that", "from", "are", "was", "be", "it", "by", "at", "or", "not", "all", "out", "here"],
  fr: ["le", "la", "les", "des", "du", "de", "et", "est", "dans", "pour", "avec", "sur", "pas", "au", "aux", "un", "une", "je", "il", "elle", "nous", "vous", "qu", "que", "qui", "ne", "se", "en", "plus", "ce", "cette", "son", "sa", "mais", "tout", "être", "avoir", "ici"],
  de: ["der", "die", "das", "und", "ist", "von", "den", "dem", "mit", "für", "auf", "nicht", "ein", "eine", "zu", "im", "als", "auch", "wir", "sie", "aus", "bei", "oder", "wenn", "noch", "nur", "schon", "hat", "war"],
  es: ["el", "los", "las", "la", "y", "en", "para", "con", "por", "del", "al", "un", "una", "es", "más", "pero", "como", "este", "esta", "todo", "cuando", "donde", "porque", "muy", "ya", "si", "no", "aquí", "ahora"],
  it: ["il", "lo", "la", "gli", "le", "di", "del", "della", "delle", "dei", "che", "non", "per", "con", "una", "sono", "questo", "questa", "più", "come", "dove", "anche", "però", "nel", "ed", "ma"],
  pt: ["o", "a", "os", "as", "de", "do", "da", "dos", "das", "em", "um", "uma", "para", "com", "por", "não", "mais", "mas", "como", "este", "esta", "que", "já", "tudo", "quando", "onde", "aqui", "agora"],
  ru: ["и", "в", "на", "с", "по", "для", "не", "что", "это", "как", "вы", "мы", "он", "она", "они", "но", "из", "за", "же", "есть", "весь", "все", "здесь", "сейчас", "или", "когда", "где", "уже", "тоже"],
  uk: ["та", "і", "в", "на", "з", "по", "для", "не", "що", "це", "як", "ви", "ми", "він", "вона", "вони", "але", "із", "бути", "тут", "зараз", "або", "коли", "де", "вже", "також"],
  ro: ["și", "în", "pe", "de", "la", "cu", "nu", "este", "sunt", "mai", "un", "acest", "această", "dar", "sau", "când", "unde", "aici", "acum", "tot"],
  pl: ["i", "w", "na", "z", "dla", "nie", "to", "jest", "oraz", "ten", "ta", "tak", "jak", "kiedy", "tutaj", "teraz", "albo", "czy", "już"],
  nl: ["het", "een", "van", "en", "is", "op", "voor", "met", "nieuwe", "niet", "dat", "die", "deze", "ook", "maar", "nu", "hier", "zijn", "waren"],
};

/** Жанровые маркеры YouTube-описаний, вес 3: формы различаются акцентами
 * («musique»/«música»/«musik») — общие синонимы («disponible» fr/es) обоим. */
const STRONG_WORDS: Record<string, readonly string[]> = {
  en: ["official", "video", "music", "available", "watch", "listen", "subscribe", "channel", "single", "album", "concert", "song", "lyrics", "remix", "track"],
  fr: ["disponible", "extrait", "nouveau", "officiel", "officielle", "chanson", "clip", "titre", "exclusif", "intégral", "vidéo", "musique", "scène", "tournée", "sortie", "écoute", "écouter", "meilleur", "bacs", "années"],
  de: ["musik", "offizielle", "offizieller", "lied", "lieder", "konzert", "verfügbar", "neu", "aufnahme", "hören", "anzusehen", "abonnieren", "kanal", "jetzt", "hier"],
  es: ["disponible", "música", "vídeo", "oficial", "canción", "álbum", "concierto", "escucha", "escuchar", "nuevo", "nueva", "tema", "película", "directo", "gira", "sencillo", "suscríbete", "países"],
  it: ["musica", "video", "ufficiale", "canzone", "disponibile", "nuovo", "nuova", "ascolta", "ascoltare", "guarda", "brano", "turneo", "cinema"],
  pt: ["música", "vídeo", "oficial", "canção", "álbum", "show", "disponível", "novo", "nova", "ouça", "ouvir", "assista", "faixa", "turnê", "filme", "inscreva"],
  ru: ["песня", "клип", "альбом", "концерт", "официальный", "официальное", "видео", "музыка", "доступен", "доступно", "новый", "новая", "смотреть", "слушать", "канал", "фильм"],
  uk: ["пісня", "кліп", "альбом", "концерт", "офіційний", "офіційне", "відео", "музика", "доступний", "новий", "нова", "дивитися", "слухати", "канал", "фільм"],
  ro: ["cântec", "videoclip", "oficial", "disponibil", "nou", "nouă", "ascultă", "piesă", "turneu", "film", "muzică"],
  pl: ["piosenka", "teledysk", "dostępny", "słuchaj", "oglądaj", "film", "muzyka", "nowy", "nowa", "oficjalny"],
  nl: ["muziek", "video", "officiële", "lied", "beschikbaar", "nieuwe", "luister", "kijk", "kanaal"],
};

/** Диакритика, вес 0.5 за символ (потолок 6 на язык): различает fr/de/es/ro/pl. */
const DIACRITIC_CHARS: Record<string, readonly string[]> = {
  fr: ["é", "è", "ê", "à", "â", "ç", "ù", "û", "î", "ô", "œ", "æ"],
  de: ["ü", "ä", "ö", "ß"],
  es: ["ñ", "á", "í", "ó", "ú", "¿", "¡"],
  it: ["à", "ù", "ò"],
  pt: ["ã", "õ", "á", "í", "ó", "ú", "ç", "â", "ê"],
  ro: ["ă", "ș", "ț", "â"],
  pl: ["ą", "ć", "ę", "ł", "ń", "ś", "ź", "ż"],
};

const DIA_WEIGHT = 0.5;
const DIA_CAP = 6;
/** Порог и отрыв победителя: ниже — детект неясен (en-фолбэк п.5/defaultSetIds). */
const MIN_SCORE = 4;
const RUNNER_RATIO = 1.5;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Язык текстов метаданных видео: двухбуквенный код (en/fr/de/es/it/pt/ru/uk/
 * ro/pl/nl/ja/ko/zh/ar/he) или null — детект неясен. Скрипты (кириллица/
 * кана/хангыль/хань/арабица/иврит) распознаются напрямую, латиница —
 * стоп-словами и диакритикой. */
export function detectMetaLanguage(meta: MetaLangTexts | undefined | null): string | null {
  if (!meta || typeof meta !== "object") return null;
  // Описание весомее названия (длиннее), но счёт идёт по словам — порядок
  // склейки на итог не влияет.
  const text = `${str(meta.title)} ${str(meta.author)} ${str(meta.shortDescription)}`.slice(0, 4000);
  if (text.trim().length === 0) return null;
  const scores = new Map<string, number>();
  const bump = (lang: string, n: number): void => {
    scores.set(lang, (scores.get(lang) ?? 0) + n);
  };

  // Скрипты: кириллица ru/uk (і ї є ґ в русском не бывают — достаточно
  // горсти), кана ja, хангыль ko, хань zh, арабица ar, иврит he.
  const cyr = text.match(/[\u0400-\u04FF]/g)?.length ?? 0;
  if (cyr >= 4) {
    const ukOnly = (text.match(/[іїєґІЇЄҐ]/g) ?? []).length;
    if (ukOnly >= Math.max(2, cyr / 20)) bump("uk", cyr);
    else bump("ru", cyr);
  }
  const kana = (text.match(/[\u3040-\u30FF]/g) ?? []).length;
  if (kana >= 2) bump("ja", 10);
  if ((text.match(/[\uAC00-\uD7AF]/g) ?? []).length >= 2) bump("ko", 10);
  // Хань без каны/хангыля — китайский (с ними — японский/корейский выше)
  if (kana === 0 && (text.match(/[\uAC00-\uD7AF]/g) ?? []).length === 0) {
    if ((text.match(/[\u4E00-\u9FFF]/g) ?? []).length >= 2) bump("zh", 10);
  }
  if ((text.match(/[\u0600-\u06FF]/g) ?? []).length >= 4) bump("ar", 10);
  if ((text.match(/[\u0590-\u05FF]/g) ?? []).length >= 4) bump("he", 10);

  // Латиница: стоп-слова и маркеры по токенам (апострофы — часть клитик
  // «l'histoire» → «l», «histoire»; URL вырождаются в шумовые токены).
  const tokens = text.toLowerCase().match(/[\p{L}\p{M}']+/gu) ?? [];
  if (tokens.length >= 4) {
    const fnIndex = new Map<string, Array<{ lang: string; w: number }>>();
    for (const [lang, words] of Object.entries(FUNCTION_WORDS)) {
      for (const w of words) {
        const arr = fnIndex.get(w) ?? [];
        arr.push({ lang, w: 1 });
        fnIndex.set(w, arr);
      }
    }
    const strongIndex = new Map<string, Array<{ lang: string; w: number }>>();
    for (const [lang, words] of Object.entries(STRONG_WORDS)) {
      for (const w of words) {
        const arr = strongIndex.get(w) ?? [];
        arr.push({ lang, w: 3 });
        strongIndex.set(w, arr);
      }
    }
    const diaIndex = new Map<string, number>();
    for (const [lang, chars] of Object.entries(DIACRITIC_CHARS)) {
      let n = 0;
      for (const ch of chars) n += (text.toLowerCase().split(ch).length - 1) * DIA_WEIGHT;
      if (n > 0) diaIndex.set(lang, Math.min(n, DIA_CAP));
    }
    for (const t of tokens) {
      for (const hit of fnIndex.get(t) ?? []) bump(hit.lang, hit.w);
      for (const hit of strongIndex.get(t) ?? []) bump(hit.lang, hit.w);
    }
    for (const [lang, n] of diaIndex) bump(lang, n);
  }
  if (scores.size === 0) return null;
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [topLang, top] = ranked[0];
  const runner = ranked[1]?.[1] ?? 0;
  if (top < MIN_SCORE) return null;
  if (runner > 0 && top < runner * RUNNER_RATIO) return null;
  return topLang;
}
