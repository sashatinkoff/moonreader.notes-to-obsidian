/* MoonReader Importer — порт moonreader_notes_to_obsidian.py
 * Обычный JS без сборки и зависимостей: достаточно положить manifest.json и main.js
 * в .obsidian/plugins/moonreader-importer/ и включить плагин.
 */
const { Plugin, Modal, Setting, PluginSettingTab, Notice, TFile, TFolder, MarkdownRenderer, AbstractInputSuggest, normalizePath } = require("obsidian");

const MAX_BOOK_NAME_LEN = 100;
const BOOK_EXTENSIONS = /\.(epub|fb2|fb2\.zip|mobi|pdf|djvu|txt|azw3?)$/i;

const DEFAULT_SETTINGS = {
  booksFolder: "Прочитанные книги", // сюда кладутся карточки книг (Название.md)
  notesFolder: "Прочитанные книги", // сюда кладутся папки "Название.notes"
  lastAuthor: "",
};

/* ---------- Логика (1:1 с Python-скриптом) ---------- */

function cleanBrTags(text) {
  if (!text) return "";
  return text.replace(/<BR\s*\/?>/gi, "\n").replace(/\u200b/g, "").trim();
}

function getValidFilename(num, text) {
  if (!text) return String(num);
  const words = text.match(/[\p{L}\p{N}_]+/gu) || [];
  // кроме запрещённых символов убираем те, что ломают [[ссылки]]: # ^ [ ]
  const short = words.slice(0, 5).join(" ").replace(/[\\/*?:"<>|#^\[\]]/g, "");
  return `${num} ${short}`.trim();
}

function cleanTitle(raw) {
  const title = raw.replace(/[«»<>:"/\\|?*#^\[\]]/g, "");
  return title.slice(0, MAX_BOOK_NAME_LEN - 6).trim() || "Без названия";
}

function basenameNoExt(p) {
  const base = p.split(/[\\/]/).pop();
  return base.replace(BOOK_EXTENSIONS, "");
}

function slugToPrettyTitle(slug) {
  return slug
    .replace(/[-_]?\d{6,}$/, "")
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSlugLike(title, basename) {
  if (!title) return true;
  if (BOOK_EXTENSIONS.test(title)) return true;
  if (title === basename) return true;
  if (!title.includes(" ") && (title.includes("_") || /-\d+$/.test(title))) return true;
  return false;
}

function parseBlocks(content) {
  const raw = content.split("\n#\n");
  const blocks = [];
  for (const rb of raw) {
    const first = rb.split("\n", 1)[0].trim();
    if (blocks.length && !/^\d+$/.test(first)) {
      blocks[blocks.length - 1] += "\n#\n" + rb; // хвост предыдущей заметки
    } else {
      blocks.push(rb);
    }
  }
  return blocks;
}

function parseNote(block) {
  const lines = block.split("\n").map((l) => l.trim());
  if (lines.length < 11) return null;

  const noteId = lines[0];
  const rawTitle = lines[1];
  const bookPath = lines[2] || "";
  const bookKey = bookPath || rawTitle;

  let content = lines.slice(10);
  while (content.length && (content[content.length - 1] === "0" || content[content.length - 1] === "")) content.pop();
  while (content.length && content[0] === "") content.shift();
  if (!content.length) return null;

  let rawComment = "";
  let rawQuote;
  if (content.length === 1) {
    rawQuote = content[0];
  } else {
    rawComment = content[0];
    rawQuote = content.slice(1).join("\n");
  }
  return { noteId, rawTitle, bookKey, comment: cleanBrTags(rawComment), quote: cleanBrTags(rawQuote) };
}

function resolveBookTitles(notes) {
  const byKey = new Map();
  for (const n of notes) {
    if (!byKey.has(n.bookKey)) byKey.set(n.bookKey, []);
    byKey.get(n.bookKey).push(n.rawTitle);
  }
  const resolved = new Map();
  for (const [key, titles] of byKey) {
    const base = basenameNoExt(key);
    const nice = titles.filter((t) => !isSlugLike(t, base));
    let chosen;
    if (nice.length) {
      const counts = new Map();
      nice.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1));
      chosen = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    } else {
      chosen = slugToPrettyTitle(base) || base;
    }
    resolved.set(key, cleanTitle(chosen));
  }
  return resolved;
}

function makeNoteFileName(note) {
  const src = note.quote ? note.quote.split("\n")[0] : note.comment.split("\n")[0];
  return getValidFilename(note.noteId, src) + ".md";
}

function assignNeighborLinks(notes, titles) {
  const byBook = new Map();
  for (const n of notes) {
    n.bookTitle = titles.get(n.bookKey);
    n.fileName = makeNoteFileName(n);
    n.linkName = n.fileName.slice(0, -3);
    n.prev = null;
    n.next = null;
    if (!byBook.has(n.bookTitle)) byBook.set(n.bookTitle, []);
    byBook.get(n.bookTitle).push(n);
  }
  for (const list of byBook.values()) {
    list.forEach((n, i) => {
      if (i > 0) n.prev = list[i - 1].linkName;
      if (i < list.length - 1) n.next = list[i + 1].linkName;
    });
  }
}

function buildNoteFrontmatter(author, bookTitle, prev, next) {
  const l = ["---", `Автор: ${author}`, "Источник:", `  - ${bookTitle}`];
  if (prev) l.push(`Предыдущая заметка: "[[${prev}]]"`);
  if (next) l.push(`Следующая заметка: "[[${next}]]"`);
  l.push("---");
  return l.join("\n");
}

function today() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/* ---------- Работа с хранилищем ---------- */

async function ensureFolder(vault, path) {
  const parts = normalizePath(path).split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (!vault.getAbstractFileByPath(cur)) await vault.createFolder(cur);
  }
}

async function writeFile(vault, path, data) {
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) await vault.modify(existing, data);
  else await vault.create(path, data);
}

async function importNotes(plugin, text, author) {
  const { vault } = plugin.app;
  const { booksFolder, notesFolder } = plugin.settings;

  const content = text.replace(/\r\n?/g, "\n");
  const notes = parseBlocks(content).map(parseNote).filter(Boolean);
  if (!notes.length) throw new Error("В файле не найдено ни одной заметки.");

  assignNeighborLinks(notes, resolveBookTitles(notes));

  await ensureFolder(vault, booksFolder);
  const processed = new Set();
  const date = today();

  for (const n of notes) {
    const dir = normalizePath(`${notesFolder}/${n.bookTitle}.notes`);
    await ensureFolder(vault, dir);

    if (!processed.has(n.bookTitle)) {
      const index = `---
Автор:
  - ${author}
Название: ${n.bookTitle}
Дата прочтения: ${date}
Прочитано: true
Оценка: 
Жанр:
cover:
Заметки: "[[${n.linkName}]]"
tags:
---
`;
      await writeFile(vault, normalizePath(`${booksFolder}/${n.bookTitle}.md`), index);
      processed.add(n.bookTitle);
    }

    let md = `${buildNoteFrontmatter(author, n.bookTitle, n.prev, n.next)}\n\n> [!quote]\n> ${n.quote.replace(/\n/g, "\n> ")}\n`;
    if (n.comment) md += `\n${n.comment}\n`;
    await writeFile(vault, normalizePath(`${dir}/${n.fileName}`), md.trim() + "\n");
  }
  return { notes: notes.length, books: processed.size };
}

/* ---------- Интерфейс ---------- */

class ImportModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.author = plugin.settings.lastAuthor || "";
    this.file = null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Импорт заметок MoonReader" });

    new Setting(contentEl)
      .setName("Файл экспорта")
      .setDesc("Текстовый файл с заметками из Moon+ Reader")
      .addButton((b) => {
        const input = contentEl.createEl("input", { type: "file" });
        input.style.display = "none";
        input.addEventListener("change", () => {
          this.file = input.files[0] || null;
          b.setButtonText(this.file ? this.file.name : "Выбрать файл…");
        });
        b.setButtonText("Выбрать файл…").onClick(() => input.click());
      });

    new Setting(contentEl)
      .setName("Автор книги")
      .setDesc("Будет записан во все заметки")
      .addText((t) => t.setValue(this.author).onChange((v) => (this.author = v)));

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Импортировать").setCta().onClick(async () => {
        if (!this.file) return new Notice("Выберите файл.");
        if (!this.author.trim()) return new Notice("Укажите автора.");
        b.setDisabled(true);
        try {
          const text = await this.file.text();
          const author = this.author.trim();
          const res = await importNotes(this.plugin, text, author);
          this.plugin.settings.lastAuthor = author;
          await this.plugin.saveSettings();
          new Notice(`Готово: заметок — ${res.notes}, книг — ${res.books}.`);
          this.close();
        } catch (e) {
          console.error(e);
          new Notice("Ошибка импорта: " + e.message);
          b.setDisabled(false);
        }
      })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* Подсказка существующих папок хранилища для текстовых полей */
class FolderSuggest extends AbstractInputSuggest {
  constructor(app, inputEl) {
    super(app, inputEl);
    this.inputEl = inputEl;
  }
  getSuggestions(query) {
    const q = query.toLowerCase();
    return this.app.vault
      .getAllLoadedFiles()
      .filter((f) => f instanceof TFolder && f.path !== "/" && f.path.toLowerCase().includes(q))
      .sort((a, b) => a.path.localeCompare(b.path, "ru"));
  }
  renderSuggestion(folder, el) {
    el.setText(folder.path);
  }
  selectSuggestion(folder) {
    this.inputEl.value = folder.path;
    this.inputEl.trigger("input");
    this.close();
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  async display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Папка карточек книг")
      .setDesc("Сюда создаются файлы «Название книги.md». Выберите существующий каталог или введите новый путь")
      .addText((t) => {
        new FolderSuggest(this.app, t.inputEl);
        t.setPlaceholder("Начните вводить, чтобы выбрать папку")
          .setValue(this.plugin.settings.booksFolder)
          .onChange(async (v) => {
            this.plugin.settings.booksFolder = v.trim();
            await this.plugin.saveSettings();
          });
      });
    new Setting(containerEl)
      .setName("Папка заметок")
      .setDesc("Сюда создаются папки «Название книги.notes» с цитатами")
      .addText((t) => {
        new FolderSuggest(this.app, t.inputEl);
        t.setPlaceholder("Начните вводить, чтобы выбрать папку")
          .setValue(this.plugin.settings.notesFolder)
          .onChange(async (v) => {
            this.plugin.settings.notesFolder = v.trim();
            await this.plugin.saveSettings();
          });
      });

    // Раздел «Описание» — рендерит README.md из папки плагина
    new Setting(containerEl).setName("Описание плагина (README)").setHeading();
    const readmeEl = containerEl.createDiv({ cls: "moonreader-importer-readme markdown-rendered" });
    let md;
    try {
      md = await this.app.vault.adapter.read(normalizePath(`${this.plugin.manifest.dir}/README.md`));
    } catch (e) {
      md = "Файл `README.md` не найден в папке плагина. Положите его рядом с `main.js` и `manifest.json`.";
    }
    await MarkdownRenderer.render(this.app, md, readmeEl, "", this.plugin);
  }
}

module.exports = class MoonReaderImporter extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addCommand({
      id: "import-moonreader-notes",
      name: "Импортировать заметки MoonReader",
      callback: () => new ImportModal(this.app, this).open(),
    });
    this.addRibbonIcon("book-open", "Импорт заметок MoonReader", () => new ImportModal(this.app, this).open());
    this.addSettingTab(new SettingsTab(this.app, this));
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
