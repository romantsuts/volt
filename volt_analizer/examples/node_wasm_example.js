const fs = require("fs");
const path = require("path");

// 1. Подключаем стандартный рантайм Go для WebAssembly
require(path.join(__dirname, "..", "wasm_exec.js"));

async function main() {
  const go = new Go();
  const wasmBuffer = fs.readFileSync(path.join(__dirname, "..", "lib.wasm"));
  const { instance } = await WebAssembly.instantiate(wasmBuffer, go.importObject);

  // Запускаем Go-рантайм в фоне (не делаем await, так как main() в Go висит на канале <-c,
  // чтобы экспортированные функции оставались доступными).
  // Инициализация gnubg.Init() синхронная и завершается сразу при вызове go.run().
  go.run(instance);

  // Пример 1: Решение по кубу (Money game, у X перевес в гонке -> DOUBLE_TAKE)
  const cubeInput = {
    board: {
      x: { "1": 2, "2": 2, "3": 3, "4": 3, "5": 3, "6": 2 },
      o: { "1": 2, "2": 2, "3": 2, "4": 3, "5": 3, "6": 3 },
    },
    player: "x",
    cube: 1,
    "cube-owner": "centered",
    plies: 2,
  };

  const cubeOutputRaw = globalThis.wasm_get_cube_decision(JSON.stringify(cubeInput));
  const cubeDecision = JSON.parse(cubeOutputRaw);
  console.log("=== Cube Decision (Money Game) ===");
  console.log(JSON.stringify(cubeDecision, null, 2));

  // Пример 2: Решение по кубу в матче до 5 очков (счёт X: 2, O: 2)
  const matchCubeInput = {
    board: {
      x: { "1": 2, "2": 2, "3": 3, "4": 3, "5": 3, "6": 2 },
      o: { "1": 2, "2": 2, "3": 2, "4": 3, "5": 3, "6": 3 },
    },
    player: "x",
    cube: 1,
    "cube-owner": "centered",
    "match-to": 5,
    score: { x: 2, o: 2 },
    crawford: false,
    plies: 2,
  };

  const matchCubeDecision = JSON.parse(
    globalThis.wasm_get_cube_decision(JSON.stringify(matchCubeInput))
  );
  console.log("\n=== Cube Decision (Match to 5, Score 2-2) ===");
  console.log(JSON.stringify(matchCubeDecision, null, 2));

  // Пример 3: Расчёт лучших ходов (проверка существующей функции wasm_get_moves)
  const movesInput = {
    board: {
      x: { "6": 5, "8": 3, "13": 5, "24": 2 },
      o: { "6": 5, "8": 3, "13": 5, "24": 2 },
    },
    cubeful: true,
    dice: [3, 1],
    "max-moves": 2,
    player: "x",
    "score-moves": true,
  };

  const moves = JSON.parse(globalThis.wasm_get_moves(JSON.stringify(movesInput)));
  console.log("\n=== Best Moves for 3-1 ===");
  console.log(JSON.stringify(moves, null, 2));

  // Завершаем процесс Node.js, так как Go-рантайм держит открытый канал
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
