/**
 * Abliterated (uncensored) model catalogue, as a data module.
 *
 * ⚠️ GENERATED FILE — edit `data/models-jailbreak.json` and re-run
 * `node scripts/embed-abliterated.mjs` instead of editing this by hand.
 *
 * WHY A .ts MODULE AND NOT THE JSON DIRECTLY
 * ------------------------------------------
 * The JSON is deliberately NOT published: it lists uncensored model
 * repositories, and having that tied to a public identity is a liability. But
 * `lineCatalog.ts` needs the data at *link time*, and a static ESM import of a
 * missing file is an uncatchable error — the whole bundle fails, so a fresh
 * clone can neither build nor run a single test. That is how this project's
 * first CI run failed.
 *
 * So the data is projected into this module, which ALWAYS exists:
 *   - the published repository ships the empty array;
 *   - a working copy fills it in.
 *
 * This file is gitignored. `abliterated.generated.example.ts` documents the
 * entry shape.
 */

export interface RawAbliteratedEntry {
  readonly id: string
  readonly displayName: string
  readonly quantization: string
  readonly fileName: string
  readonly bytes: number
  readonly downloadUrl: string
  readonly sharded: boolean
  readonly source: string
  readonly repo: string
  readonly sha256: string
}

export const ABLITERATED_ENTRIES: readonly RawAbliteratedEntry[] = [
  {
    "id": "huihui-qwen3-0-6b-abliterated-v2",
    "displayName": "Huihui-Qwen3-0.6B-abliterated-v2 [Q4_K_M]",
    "quantization": "Q4_K_M",
    "fileName": "Huihui-Qwen3-0.6B-abliterated-v2.i1-Q4_K_M.gguf",
    "bytes": 396701536,
    "sizeMB": 378.32,
    "downloadUrl": "https://modelscope.cn/models/mradermacher/Huihui-Qwen3-0.6B-abliterated-v2-i1-GGUF/resolve/master/Huihui-Qwen3-0.6B-abliterated-v2.i1-Q4_K_M.gguf",
    "sharded": false,
    "source": "modelscope",
    "repo": "mradermacher/Huihui-Qwen3-0.6B-abliterated-v2-i1-GGUF",
    "sha256": "2b0e76d4ff7819da12b97c4dce34d2f6802f86195fb87c401323e4e2458b393b"
  },
  {
    "id": "huihui-qwen3-1-7b-abliterated-v2",
    "displayName": "Huihui-Qwen3-1.7B-abliterated-v2 [Q4_K_M]",
    "quantization": "Q4_K_M",
    "fileName": "Huihui-Qwen3-1.7B-abliterated-v2.i1-Q4_K_M.gguf",
    "bytes": 1107405664,
    "sizeMB": 1056.1,
    "downloadUrl": "https://modelscope.cn/models/mradermacher/Huihui-Qwen3-1.7B-abliterated-v2-i1-GGUF/resolve/master/Huihui-Qwen3-1.7B-abliterated-v2.i1-Q4_K_M.gguf",
    "sharded": false,
    "source": "modelscope",
    "repo": "mradermacher/Huihui-Qwen3-1.7B-abliterated-v2-i1-GGUF",
    "sha256": "578d94267903dc808e476ba8f94f65e5cd8cca29d9a1110b65407d76c56689ac"
  },
  {
    "id": "llama-3-2-3b-instruct-abliterated-finetuned",
    "displayName": "Llama-3.2-3B-Instruct-abliterated-finetuned [Q4_K_M]",
    "quantization": "Q4_K_M",
    "fileName": "Llama-3.2-3B-Instruct-abliterated-finetuned.i1-Q4_K_M.gguf",
    "bytes": 2019378400,
    "sizeMB": 1925.83,
    "downloadUrl": "https://modelscope.cn/models/mradermacher/Llama-3.2-3B-Instruct-abliterated-finetuned-i1-GGUF/resolve/master/Llama-3.2-3B-Instruct-abliterated-finetuned.i1-Q4_K_M.gguf",
    "sharded": false,
    "source": "modelscope",
    "repo": "mradermacher/Llama-3.2-3B-Instruct-abliterated-finetuned-i1-GGUF",
    "sha256": "4d5d65261bbd503a037595f091448decfa68acc71b57fd9cc93d345eef7c261a"
  },
  {
    "id": "gemma-3-4b-it-abliterated",
    "displayName": "gemma-3-4b-it-abliterated [Q4_K_M]",
    "quantization": "Q4_K_M",
    "fileName": "gemma-3-4b-it-abliterated.i1-Q4_K_M.gguf",
    "bytes": 2489894720,
    "sizeMB": 2374.55,
    "downloadUrl": "https://modelscope.cn/models/mradermacher/gemma-3-4b-it-abliterated-i1-GGUF/resolve/master/gemma-3-4b-it-abliterated.i1-Q4_K_M.gguf",
    "sharded": false,
    "source": "modelscope",
    "repo": "mradermacher/gemma-3-4b-it-abliterated-i1-GGUF",
    "sha256": "60b05ac49a1ca6de826a89360d3b4d8da477ee22227afa483b3685f5a0de3035"
  },
  {
    "id": "huihui-qwen3-4b-abliterated-v2",
    "displayName": "Huihui-Qwen3-4B-abliterated-v2 [Q4_K_M]",
    "quantization": "Q4_K_M",
    "fileName": "Huihui-Qwen3-4B-abliterated-v2.i1-Q4_K_M.gguf",
    "bytes": 2497277376,
    "sizeMB": 2381.59,
    "downloadUrl": "https://modelscope.cn/models/mradermacher/Huihui-Qwen3-4B-abliterated-v2-i1-GGUF/resolve/master/Huihui-Qwen3-4B-abliterated-v2.i1-Q4_K_M.gguf",
    "sharded": false,
    "source": "modelscope",
    "repo": "mradermacher/Huihui-Qwen3-4B-abliterated-v2-i1-GGUF",
    "sha256": "c9622b4a85d51fba5769107a38b486132082bc43c04ba0227ad2d2459986047e"
  },
  {
    "id": "josiefied-qwen2-5-7b-instruct-abliterated",
    "displayName": "Josiefied-Qwen2.5-7B-Instruct-abliterated [Q4_K_M]",
    "quantization": "Q4_K_M",
    "fileName": "Josiefied-Qwen2.5-7B-Instruct-abliterated.i1-Q4_K_M.gguf",
    "bytes": 4683074944,
    "sizeMB": 4466.13,
    "downloadUrl": "https://modelscope.cn/models/mradermacher/Josiefied-Qwen2.5-7B-Instruct-abliterated-i1-GGUF/resolve/master/Josiefied-Qwen2.5-7B-Instruct-abliterated.i1-Q4_K_M.gguf",
    "sharded": false,
    "source": "modelscope",
    "repo": "mradermacher/Josiefied-Qwen2.5-7B-Instruct-abliterated-i1-GGUF",
    "sha256": "862410b019b8dd27830dc1555b07691fb8272b735d28c05ef994f872e5032f7c"
  },
  {
    "id": "meta-llama-3-8b-instruct-abliterated",
    "displayName": "Meta-Llama-3-8B-Instruct-abliterated [Q4_K_M]",
    "quantization": "Q4_K_M",
    "fileName": "Meta-Llama-3-8B-Instruct-abliterated.i1-Q4_K_M.gguf",
    "bytes": 4920739424,
    "sizeMB": 4692.78,
    "downloadUrl": "https://modelscope.cn/models/mradermacher/Meta-Llama-3-8B-Instruct-abliterated-i1-GGUF/resolve/master/Meta-Llama-3-8B-Instruct-abliterated.i1-Q4_K_M.gguf",
    "sharded": false,
    "source": "modelscope",
    "repo": "mradermacher/Meta-Llama-3-8B-Instruct-abliterated-i1-GGUF",
    "sha256": "5542afc4817211a4ba8ad9241cc5c190735580219f67f1675d3914f9d7ab8192"
  },
  {
    "id": "huihui-qwen3-8b-abliterated-v2",
    "displayName": "Huihui-Qwen3-8B-abliterated-v2 [Q4_K_M]",
    "quantization": "Q4_K_M",
    "fileName": "Huihui-Qwen3-8B-abliterated-v2.i1-Q4_K_M.gguf",
    "bytes": 5027780576,
    "sizeMB": 4794.87,
    "downloadUrl": "https://modelscope.cn/models/mradermacher/Huihui-Qwen3-8B-abliterated-v2-i1-GGUF/resolve/master/Huihui-Qwen3-8B-abliterated-v2.i1-Q4_K_M.gguf",
    "sharded": false,
    "source": "modelscope",
    "repo": "mradermacher/Huihui-Qwen3-8B-abliterated-v2-i1-GGUF",
    "sha256": "50a6b054a9331ac60b35508b3a0f7848a90ef5f6bf8b358e51d71002572a8a78"
  },
  {
    "id": "gemma-3-12b-it-abliterated",
    "displayName": "gemma-3-12b-it-abliterated [Q4_K_M]",
    "quantization": "Q4_K_M",
    "fileName": "gemma-3-12b-it-abliterated.i1-Q4_K_M.gguf",
    "bytes": 7300779072,
    "sizeMB": 6962.57,
    "downloadUrl": "https://modelscope.cn/models/mradermacher/gemma-3-12b-it-abliterated-i1-GGUF/resolve/master/gemma-3-12b-it-abliterated.i1-Q4_K_M.gguf",
    "sharded": false,
    "source": "modelscope",
    "repo": "mradermacher/gemma-3-12b-it-abliterated-i1-GGUF",
    "sha256": "d8bd08d3d565d791bbb68b52cf71812523c57e628aed158a05a2d365b68f5599"
  },
  {
    "id": "huihui-qwen3-14b-abliterated-v2",
    "displayName": "Huihui-Qwen3-14B-abliterated-v2 [Q4_K_M]",
    "quantization": "Q4_K_M",
    "fileName": "Huihui-Qwen3-14B-abliterated-v2.i1-Q4_K_M.gguf",
    "bytes": 9001750048,
    "sizeMB": 8584.74,
    "downloadUrl": "https://modelscope.cn/models/mradermacher/Huihui-Qwen3-14B-abliterated-v2-i1-GGUF/resolve/master/Huihui-Qwen3-14B-abliterated-v2.i1-Q4_K_M.gguf",
    "sharded": false,
    "source": "modelscope",
    "repo": "mradermacher/Huihui-Qwen3-14B-abliterated-v2-i1-GGUF",
    "sha256": "84673b0c0c239db87f2aa67b919e0ef920301ca85b50cc1a8b7b2a21ef997183"
  },
  {
    "id": "qwen3-30b-a3b-abliterated-erotic",
    "displayName": "Qwen3-30B-A3B-abliterated-erotic [Q4_K_M]",
    "quantization": "Q4_K_M",
    "fileName": "Qwen3-30B-A3B-abliterated-erotic.i1-Q4_K_M.gguf",
    "bytes": 18556686976,
    "sizeMB": 17697.04,
    "downloadUrl": "https://modelscope.cn/models/mradermacher/Qwen3-30B-A3B-abliterated-erotic-i1-GGUF/resolve/master/Qwen3-30B-A3B-abliterated-erotic.i1-Q4_K_M.gguf",
    "sharded": false,
    "source": "modelscope",
    "repo": "mradermacher/Qwen3-30B-A3B-abliterated-erotic-i1-GGUF",
    "sha256": "503179b37941385bdd2c02e144bd940c508d40e10192d2a4a20fd846bf43e982"
  }
] as const
