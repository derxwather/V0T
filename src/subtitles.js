import youtubeUtils from "./utils/youtubeUtils.js";
import { lang, GM_fetch } from "./utils/utils.js";
import { yandexProtobuf } from "./yandexProtobuf.js";
import requestVideoSubtitles from "./rvs.js";
import debug from "./utils/debug.js";

function formatYandexSubtitlesTokens(line) {
  const lineEndMs = line.startMs + line.durationMs;
  return line.tokens.reduce((result, token, index) => {
    const nextToken = line.tokens[index + 1];
    let lastToken;
    if (result.length > 0) {
      lastToken = result[result.length - 1];
    }
    const alignRangeEnd = lastToken?.alignRange?.end ?? 0;
    const newAlignRangeEnd = alignRangeEnd + token.text.length;
    token.alignRange = {
      start: alignRangeEnd,
      end: newAlignRangeEnd,
    };
    result.push(token);
    if (nextToken) {
      const endMs = token.startMs + token.durationMs;
      const durationMs = nextToken.startMs
        ? nextToken.startMs - endMs
        : lineEndMs - endMs;
      result.push({
        text: " ",
        startMs: endMs,
        durationMs,
        alignRange: {
          start: newAlignRangeEnd,
          end: newAlignRangeEnd + 1,
        },
      });
    }
    return result;
  }, []);
}

function createSubtitlesTokens(line, previousLineLastToken) {
  const tokens = line.text.split(/([\n \t])/).reduce((result, tokenText) => {
    if (tokenText.length) {
      const lastToken = result[result.length - 1] ?? previousLineLastToken;
      const alignRangeStart = lastToken?.alignRange?.end ?? 0;
      const alignRangeEnd = alignRangeStart + tokenText.length;
      result.push({
        text: tokenText,
        alignRange: {
          start: alignRangeStart,
          end: alignRangeEnd,
        },
      });
    }
    return result;
  }, []);
  const tokenDurationMs = Math.floor(line.durationMs / tokens.length);
  const lineEndMs = line.startMs + line.durationMs;
  return tokens.map((token, index) => {
    const isLastToken = index === tokens.length - 1;
    const startMs = line.startMs + tokenDurationMs * index;
    const durationMs = isLastToken ? lineEndMs - startMs : tokenDurationMs;
    return {
      ...token,
      startMs,
      durationMs,
    };
  });
}

function getSubtitlesTokens(subtitles, source) {
  const result = [];
  let lastToken;
  for (let i = 0; i < subtitles.subtitles.length; i++) {
    const line = subtitles.subtitles[i];
    let tokens;
    if (line?.tokens?.length) {
      if (source === "yandex") {
        tokens = formatYandexSubtitlesTokens(line);
      } else {
        console.warn("[VOT] Unsupported subtitles tokens type: ", source);
        subtitles.containsTokens = false;
        return null;
      }
    } else {
      tokens = createSubtitlesTokens(line, lastToken);
    }
    lastToken = tokens[tokens.length - 1];
    result.push({
      ...line,
      tokens,
    });
  }
  subtitles.containsTokens = true;
  return result;
}

function formatYoutubeSubtitles(subtitles) {
  const result = {
    containsTokens: false,
    subtitles: [],
  };
  if (
    typeof subtitles !== "object" ||
    !("events" in subtitles) ||
    !Array.isArray(subtitles.events)
  ) {
    console.error("[VOT] Failed to format youtube subtitles", subtitles);
    return result;
  }
  for (let i = 0; i < subtitles.events.length; i++) {
    if (!subtitles.events[i].segs) continue;
    const text = subtitles.events[i].segs
      .map((e) => e.utf8.replace(/^( +| +)$/g, ""))
      .join(" ");
    let durationMs = subtitles.events[i].dDurationMs;
    if (
      subtitles.events[i + 1] &&
      subtitles.events[i].tStartMs + subtitles.events[i].dDurationMs >
        subtitles.events[i + 1].tStartMs
    ) {
      durationMs =
        subtitles.events[i + 1].tStartMs - subtitles.events[i].tStartMs;
    }
    if (text !== "\n") {
      result.subtitles.push({
        text,
        startMs: subtitles.events[i].tStartMs,
        durationMs,
      });
    }
  }
  return result;
}

function convertToSrtTimeFormat(seconds) {
  let hours = Math.floor(seconds / 3600);
  let minutes = Math.floor((seconds % 3600) / 60);
  let remainingSeconds = Math.floor(seconds % 60);
  let milliseconds = Math.floor((seconds % 1) * 1000);

  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")},${milliseconds.toString().padStart(3, "0")}`;
}

export function jsonToSrt(jsonData) {
  let srtContent = "";
  let index = 1;
  for (const entry of jsonData.subtitles) {
    let startTime = entry.startMs / 1000.0;
    let endTime = (entry.startMs + entry.durationMs) / 1000.0;

    srtContent += `${index}\n`;
    srtContent += `${convertToSrtTimeFormat(startTime)} --> ${convertToSrtTimeFormat(endTime)}\n`;
    srtContent += `${entry.text}\n\n`;
    index++;
  }

  return srtContent.trim();
}

export async function fetchSubtitles(subtitlesObject) {
  const timeoutPromise = new Promise((resolve) =>
    setTimeout(
      () =>
        resolve({
          containsTokens: false,
          subtitles: [],
        }),
      5000,
    ),
  );

  const fetchPromise = (async () => {
    try {
      const response = await GM_fetch(subtitlesObject.url);
      return await response.json();
    } catch (error) {
      console.error("[VOT] Failed to fetch subtitles. Reason:", error);
      return {
        containsTokens: false,
        subtitles: [],
      };
    }
  })();

  let subtitles = await Promise.race([timeoutPromise, fetchPromise]);

  if (subtitlesObject.source === "youtube") {
    subtitles = formatYoutubeSubtitles(subtitles);
  }

  subtitles.subtitles = getSubtitlesTokens(subtitles, subtitlesObject.source);
  console.log("[VOT] subtitles:", subtitles);
  return subtitles;
}

export async function getSubtitles(site, videoId, requestLang) {
  const ytSubtitles =
    site.host === "youtube" ? youtubeUtils.getSubtitles() : [];
  let resolved = false;
  const yaSubtitles = await Promise.race([
    new Promise((resolve) => {
      setTimeout(() => {
        if (!resolved) {
          console.error("[VOT] Failed get yandex subtitles. Reason: timeout");
          resolve([]);
        }
      }, 5000);
    }),
    new Promise((resolve) => {
      requestVideoSubtitles(
        `${site.url}${videoId}`,
        requestLang,
        (success, response) => {
          debug.log("[exec callback] Requesting video subtitles", videoId);

          if (!success) {
            console.error("[VOT] Failed get yandex subtitles");
            resolved = true;
            resolve([]);
          }

          const subtitlesResponse =
            yandexProtobuf.decodeSubtitlesResponse(response);
          console.log("[VOT] Subtitles response: ", subtitlesResponse);

          let subtitles = subtitlesResponse.subtitles ?? [];
          subtitles = subtitles.reduce((result, yaSubtitlesObject) => {
            if (
              yaSubtitlesObject.language &&
              !result.find((e) => {
                if (
                  e.source === "yandex" &&
                  e.language === yaSubtitlesObject.language &&
                  !e.translatedFromLanguage
                ) {
                  return e;
                }
              })
            ) {
              result.push({
                source: "yandex",
                language: yaSubtitlesObject.language,
                url: yaSubtitlesObject.url,
              });
            }
            if (yaSubtitlesObject.translatedLanguage) {
              result.push({
                source: "yandex",
                language: yaSubtitlesObject.translatedLanguage,
                translatedFromLanguage: yaSubtitlesObject.language,
                url: yaSubtitlesObject.translatedUrl,
              });
            }
            return result;
          }, []);
          resolved = true;
          resolve(subtitles);
        },
      );
    }),
  ]);
  const subtitles = [...yaSubtitles, ...ytSubtitles].sort((a, b) => {
    if (a.source !== b.source) {
      // sort by source
      return a.source === "yandex" ? -1 : 1;
    }
    if (
      a.language !== b.language &&
      (a.language === lang || b.language === lang)
    ) {
      // sort by user language
      return a.language === lang ? -1 : 1;
    }
    if (a.source === "yandex") {
      // sort by translation
      if (a.translatedFromLanguage !== b.translatedFromLanguage) {
        // sort by translatedFromLanguage
        if (!a.translatedFromLanguage || !b.translatedFromLanguage) {
          // sort by isTranslated
          if (a.language === b.language) {
            return a.translatedFromLanguage ? 1 : -1;
          }
          return !a.translatedFromLanguage ? 1 : -1;
        }
        return a.translatedFromLanguage === requestLang ? -1 : 1;
      }
      if (!a.translatedFromLanguage) {
        // sort non translated by language
        return a.language === requestLang ? -1 : 1;
      }
    }
    if (a.source === "youtube" && a.isAutoGenerated !== b.isAutoGenerated) {
      // sort by isAutoGenerated
      return a.isAutoGenerated ? 1 : -1;
    }
    return 0;
  });
  console.log("[VOT] subtitles list", subtitles);
  return subtitles;
}

export class SubtitlesWidget {
  dragging = false;
  subtitlesContainerRect = null;
  containerRect = null;
  offsetX = null;
  offsetY = null;

  lastContent = null;
  highlightWords = false;
  subtitles = null;
  maxLength = 300;
  maxLengthRegexp = /.{1,300}(?:\s|$)/g;

  constructor(video, container, site) {
    this.site = site;
    this.video = video;
    if (this.site.host === "youtube" && this.site.additionalData !== "mobile") {
      this.container = container.parentElement;
    } else {
      this.container = container;
    }

    this.votSubtitlesContainer = document.createElement("vot-block");
    this.votSubtitlesContainer.classList.add("vot-subtitles-widget");
    this.container.appendChild(this.votSubtitlesContainer);

    this.onMouseDownBound = this.onMouseDown.bind(this);
    this.onMouseUpBound = this.onMouseUp.bind(this);
    this.onMouseMoveBound = this.onMouseMove.bind(this);
    this.onTimeUpdateBound = this.onTimeUpdate.bind(this);

    document.addEventListener("mousedown", this.onMouseDownBound);
    document.addEventListener("mouseup", this.onMouseUpBound);
    document.addEventListener("mousemove", this.onMouseMoveBound);

    this.video?.addEventListener("timeupdate", this.onTimeUpdateBound);
  }

  release() {
    this.video?.removeEventListener("timeupdate", this.onTimeUpdateBound);

    document.removeEventListener("mousedown", this.onMouseDownBound);
    document.removeEventListener("mouseup", this.onMouseUpBound);
    document.removeEventListener("mousemove", this.onMouseMoveBound);

    this.votSubtitlesContainer.remove();
  }

  onMouseDown(e) {
    if (this.votSubtitlesContainer.contains(e.target)) {
      this.subtitlesContainerRect =
        this.votSubtitlesContainer.getBoundingClientRect();
      this.containerRect = this.container.getBoundingClientRect();
      this.offsetX = e.clientX - this.subtitlesContainerRect.x;
      this.offsetY = e.clientY - this.subtitlesContainerRect.y;
      this.dragging = true;
    }
  }

  onMouseUp() {
    this.dragging = false;
  }

  onMouseMove(e) {
    if (this.dragging) {
      e.preventDefault();
      const x = e.clientX - this.offsetX;
      const y = e.clientY - this.offsetY;
      const top = y >= this.containerRect.top;
      const bottom =
        y + this.subtitlesContainerRect.height <= this.containerRect.bottom;
      const left = x >= this.containerRect.left;
      const right =
        x + this.subtitlesContainerRect.width <= this.containerRect.right;

      if (top && bottom) {
        this.votSubtitlesContainer.style.top = `${y - this.containerRect.y}px`;
      } else if (!top) {
        this.votSubtitlesContainer.style.top = `${0}px`;
      } else {
        this.votSubtitlesContainer.style.top = `${
          this.containerRect.height - this.subtitlesContainerRect.height
        }px`;
      }

      if (left && right) {
        this.votSubtitlesContainer.style.left = `${x - this.containerRect.x}px`;
      } else if (!left) {
        this.votSubtitlesContainer.style.left = `${0}px`;
      } else {
        this.votSubtitlesContainer.style.left = `${
          this.containerRect.width - this.subtitlesContainerRect.width
        }px`;
      }
    }
  }

  onTimeUpdate() {
    this.update();
  }

  setContent(subtitles) {
    if (subtitles && this.video) {
      this.subtitles = subtitles;
      this.update();
    } else {
      this.subtitles = null;
      this.votSubtitlesContainer.innerHTML = "";
    }
  }

  setMaxLength(len) {
    if (typeof len === "number" && len) {
      this.maxLength = len;
      this.maxLengthRegexp = new RegExp(`.{1,${len}}(?:\\s|$)`, "g");
      this.update();
    }
  }

  setHighlightWords(value) {
    if (this.highlightWords !== !!value) {
      this.highlightWords = !!value;
      this.update();
    }
  }

  update() {
    if (!this.video) return;

    let content = "";
    let highlightWords = this.highlightWords && this.subtitles?.containsTokens;
    const time = this.video.currentTime * 1000;
    const line = this.subtitles?.subtitles?.findLast((e) => {
      return e.startMs < time && time < e.startMs + e.durationMs;
    });
    if (line) {
      let { tokens } = line;
      if (tokens.at(-1).alignRange.end > this.maxLength) {
        let chunks = [];
        let chunkStartIndex = 0;
        let chunkEndIndex = 0;
        let length = 0;
        for (let i = 0; i < tokens.length + 1; i++) {
          length += tokens[i]?.text?.length ?? 0;
          if (!tokens[i] || length > this.maxLength) {
            let t = tokens.slice(chunkStartIndex, chunkEndIndex + 1);
            if (t.at(0) && t.at(0).text === " ") t = t.slice(1);
            if (t.at(-1) && t.at(-1).text === " ") t = t.slice(0, t.length - 1);
            chunks.push({
              startMs: tokens[chunkStartIndex].startMs,
              durationMs:
                tokens[chunkEndIndex].startMs +
                tokens[chunkEndIndex].durationMs -
                tokens[chunkStartIndex].startMs,
              tokens: t,
            });
            chunkStartIndex = i;
            length = 0;
          }
          chunkEndIndex = i;
        }
        for (let index = 0; index < chunks.length; index++) {
          const chunk = chunks[index];
          if (chunk.startMs < time && time < chunk.startMs + chunk.durationMs) {
            tokens = chunk.tokens;
            break;
          }
        }
      }
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const passedMs = token.startMs + token.durationMs / 2;
        content += `<span ${
          highlightWords &&
          (time > passedMs ||
            (time > token.startMs - 100 && passedMs - time < 275))
            ? 'class="passed"'
            : ""
        }>${token.text}</span>`;
      }
    }
    if (content !== this.lastContent) {
      this.lastContent = content;
      this.votSubtitlesContainer.innerHTML = content
        ? `<vot-block class="vot-subtitles">${content.replace(
            "\\n",
            "<br>",
          )}</vot-block>`
        : "";
    }
  }
}
