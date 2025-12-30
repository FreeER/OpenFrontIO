import { PriorityQueue } from "@datastructures-js/priority-queue";
import { Colord } from "colord";
import { Theme } from "../../../core/configuration/Config";
import {
  GameMode,
  PlayerType,
  Team,
  TerrainType,
} from "../../../core/game/Game";
import { TileRef } from "../../../core/game/GameMap";
import { GameView } from "../../../core/game/GameView";
import { FrameProfiler } from "../FrameProfiler";

interface SpawnClaimSource {
  tile: TileRef;
  color: Colord;
  sortKey: string;
  team: Team | null;
}

interface SpawnClaimQueueEntry {
  tile: TileRef;
  cost: number;
  sourceIndex: number;
}

export class SpawnClaimOverlay {
  private active = true;
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private prevCanvas: HTMLCanvasElement;
  private prevContext: CanvasRenderingContext2D;
  private key: string | null = null;
  private keySet: Set<string> | null = null;
  private sourcePositions = new Map<string, { x: number; y: number }>();
  private lastUpdateMs = 0;
  private pendingKey: string | null = null;
  private pendingSources: SpawnClaimSource[] | null = null;
  private buildKey: string | null = null;
  private buildKeySet: Set<string> | null = null;
  private buildSources: SpawnClaimSource[] | null = null;
  private buildQueue: PriorityQueue<SpawnClaimQueueEntry> | null = null;
  private buildBestCost: Float32Array | null = null;
  private buildBestSource: Int32Array | null = null;
  private buildCoarseCost: Float32Array | null = null;
  private buildCoarseLand: Uint8Array | null = null;
  private buildWidth = 0;
  private buildHeight = 0;
  private readonly buildBudgetMs = 4;
  private readonly initialBuildBudgetMs = 10;
  private lastPaintMs = 0;
  private readonly paintIntervalMs = 150;
  private readonly cellSize = 2;
  private readonly sourceMoveThresholdSq = 36;
  private readonly resetOverlapRatio = 0.3;
  private readonly alpha = 70;
  private readonly minUpdateMs = 200;
  private transitionStart = 0;
  private readonly transitionDuration = 0;
  private transitionActive = false;

  constructor(
    private game: GameView,
    private theme: Theme,
  ) {
    this.initCanvases();
  }

  resize() {
    this.initCanvases();
  }

  deactivate() {
    this.resetBuild(true);
    this.key = null;
    this.keySet = null;
    this.pendingKey = null;
    this.pendingSources = null;
    this.sourcePositions.clear();
    this.lastUpdateMs = 0;
    this.transitionActive = false;
    this.active = false;
  }

  activate() {
    if (this.active) {
      return;
    }
    this.active = true;
    this.resetBuild(true);
    this.key = null;
    this.keySet = null;
    this.pendingKey = null;
    this.pendingSources = null;
    this.sourcePositions.clear();
    this.lastUpdateMs = 0;
    this.transitionActive = false;
  }

  update() {
    if (!this.active) {
      return;
    }
    const updateStart = FrameProfiler.start();
    this.updateOverlay();
    FrameProfiler.end("TerritoryLayer:spawnOverlay:update", updateStart);
  }

  render(context: CanvasRenderingContext2D) {
    if (!this.active) {
      return;
    }
    this.drawOverlay(context);
  }

  private initCanvases() {
    this.canvas = document.createElement("canvas");
    const context = this.canvas.getContext("2d", { alpha: true });
    if (context === null) throw new Error("2d context not supported");
    this.context = context;
    this.canvas.width = this.game.width();
    this.canvas.height = this.game.height();

    this.prevCanvas = document.createElement("canvas");
    const prevContext = this.prevCanvas.getContext("2d", { alpha: true });
    if (prevContext === null) throw new Error("2d context not supported");
    this.prevContext = prevContext;
    this.prevCanvas.width = this.game.width();
    this.prevCanvas.height = this.game.height();

    this.key = null;
    this.keySet = null;
    this.sourcePositions.clear();
    this.lastUpdateMs = 0;
    this.pendingKey = null;
    this.pendingSources = null;
    this.buildKey = null;
    this.buildKeySet = null;
    this.buildSources = null;
    this.buildQueue = null;
    this.buildBestCost = null;
    this.buildBestSource = null;
    this.buildCoarseCost = null;
    this.buildCoarseLand = null;
    this.buildWidth = 0;
    this.buildHeight = 0;
    this.lastPaintMs = 0;
    this.transitionActive = false;
  }

  private updateOverlay() {
    if (!this.context) {
      return;
    }
    const now = performance.now();
    let collected = this.collectSources(true);
    this.sourcePositions = collected.positions;
    let sources = collected.sources;
    let sourceKeys = new Set(sources.map((source) => source.sortKey));
    let key = sources
      .map((source) => source.sortKey)
      .sort()
      .join("|");
    const comparisonKeys = this.buildKeySet ?? this.keySet;
    if (
      comparisonKeys &&
      this.sourceOverlapRatio(sourceKeys, comparisonKeys) <
        this.resetOverlapRatio
    ) {
      this.resetBuild(true);
      this.key = null;
      this.keySet = null;
      this.pendingKey = null;
      this.pendingSources = null;
      collected = this.collectSources(false);
      this.sourcePositions = collected.positions;
      sources = collected.sources;
      sourceKeys = new Set(sources.map((source) => source.sortKey));
      key = sources
        .map((source) => source.sortKey)
        .sort()
        .join("|");
      if (key === "") {
        return;
      }
      this.startBuild(sources, key, sourceKeys);
      const budget =
        this.key === null ? this.initialBuildBudgetMs : this.buildBudgetMs;
      this.processBuild(budget);
      return;
    }
    if (this.buildQueue) {
      const budget =
        this.key === null ? this.initialBuildBudgetMs : this.buildBudgetMs;
      if (key !== this.buildKey) {
        this.pendingKey = key;
        this.pendingSources = sources;
      }
      this.processBuild(budget);
      if (
        !this.buildQueue &&
        this.pendingKey &&
        now - this.lastUpdateMs >= this.minUpdateMs
      ) {
        const pendingKey = this.pendingKey;
        const pendingSources = this.pendingSources ?? sources;
        this.pendingKey = null;
        this.pendingSources = null;
        this.startBuild(
          pendingSources,
          pendingKey,
          new Set(pendingSources.map((source) => source.sortKey)),
        );
        this.processBuild(budget);
      }
      return;
    }

    if (key === this.key) {
      return;
    }
    if (now - this.lastUpdateMs < this.minUpdateMs) {
      this.pendingKey = key;
      this.pendingSources = sources;
      return;
    }
    this.startBuild(sources, key, sourceKeys);
    const budget =
      this.key === null ? this.initialBuildBudgetMs : this.buildBudgetMs;
    this.processBuild(budget);
  }

  private beginTransition() {
    if (!this.prevContext) {
      return;
    }
    this.prevContext.clearRect(0, 0, this.game.width(), this.game.height());
    this.prevContext.drawImage(this.canvas, 0, 0);
    this.transitionStart = performance.now();
    this.transitionActive = true;
  }

  private collectSources(useThreshold: boolean): {
    sources: SpawnClaimSource[];
    positions: Map<string, { x: number; y: number }>;
  } {
    const isTeamMode =
      this.game.config().gameConfig().gameMode === GameMode.Team;
    const players = this.game.playerViews().filter((p) => {
      if (p.type() === PlayerType.Human) {
        return true;
      }
      return isTeamMode && p.type() === PlayerType.Nation && p.team() !== null;
    });
    const sources: SpawnClaimSource[] = [];
    const nextPositions = new Map<string, { x: number; y: number }>();
    for (const player of players) {
      const center = player.nameLocation();
      if (!center) {
        continue;
      }
      const playerKey = String(player.id());
      const current = { x: center.x, y: center.y };
      const previous = useThreshold
        ? this.sourcePositions.get(playerKey)
        : null;
      const dx = previous ? current.x - previous.x : 0;
      const dy = previous ? current.y - previous.y : 0;
      const stable =
        previous && dx * dx + dy * dy <= this.sourceMoveThresholdSq
          ? previous
          : current;
      nextPositions.set(playerKey, stable);
      const centerTile = this.game.ref(stable.x, stable.y);
      if (!centerTile || !this.game.isLand(centerTile)) {
        continue;
      }
      const team = player.team();
      const color =
        team !== null
          ? this.theme.teamColor(team)
          : this.theme.territoryColor(player);
      sources.push({
        tile: centerTile,
        color,
        sortKey: `${player.id()}:${stable.x},${stable.y}:${team ?? "ffa"}`,
        team,
      });
    }
    return { sources, positions: nextPositions };
  }

  private startBuild(
    sources: SpawnClaimSource[],
    key: string,
    sourceKeys: Set<string>,
  ) {
    if (sources.length === 0) {
      this.clearOverlay();
      this.key = key;
      this.keySet = sourceKeys;
      this.lastUpdateMs = performance.now();
      this.buildQueue = null;
      this.buildSources = null;
      this.buildBestCost = null;
      this.buildBestSource = null;
      this.buildCoarseCost = null;
      this.buildCoarseLand = null;
      this.buildWidth = 0;
      this.buildHeight = 0;
      this.buildKey = null;
      this.buildKeySet = null;
      return;
    }
    const scale = this.cellSize;
    const width = this.game.width();
    const height = this.game.height();
    const { coarseWidth, coarseHeight, coarseCost, coarseLand } =
      this.buildCoarseGrid(scale, width, height);
    const totalCoarse = coarseWidth * coarseHeight;
    const bestCost = new Float32Array(totalCoarse);
    const bestSource = new Int32Array(totalCoarse);
    bestCost.fill(Number.POSITIVE_INFINITY);
    bestSource.fill(-1);

    const queue = new PriorityQueue<SpawnClaimQueueEntry>(
      (a, b) => a.cost - b.cost,
    );

    sources.forEach((source, index) => {
      const x = this.game.x(source.tile);
      const y = this.game.y(source.tile);
      const cx = Math.floor(x / scale);
      const cy = Math.floor(y / scale);
      const coarseIndex = cy * coarseWidth + cx;
      if (!coarseLand[coarseIndex]) {
        return;
      }
      bestCost[coarseIndex] = 0;
      bestSource[coarseIndex] = index;
      queue.push({ tile: coarseIndex, cost: 0, sourceIndex: index });
    });

    if (queue.size() === 0) {
      this.clearOverlay();
      this.key = key;
      this.keySet = sourceKeys;
      this.lastUpdateMs = performance.now();
      this.buildQueue = null;
      this.buildSources = null;
      this.buildBestCost = null;
      this.buildBestSource = null;
      this.buildCoarseCost = null;
      this.buildCoarseLand = null;
      this.buildWidth = 0;
      this.buildHeight = 0;
      this.buildKey = null;
      this.buildKeySet = null;
      return;
    }

    this.buildKey = key;
    this.buildKeySet = sourceKeys;
    this.buildSources = sources;
    this.buildQueue = queue;
    this.buildBestCost = bestCost;
    this.buildBestSource = bestSource;
    this.buildCoarseCost = coarseCost;
    this.buildCoarseLand = coarseLand;
    this.buildWidth = coarseWidth;
    this.buildHeight = coarseHeight;
    this.lastPaintMs = 0;
  }

  private processBuild(budgetMs: number) {
    if (
      !this.buildQueue ||
      !this.buildBestCost ||
      !this.buildBestSource ||
      !this.buildCoarseCost ||
      !this.buildCoarseLand
    ) {
      return;
    }
    const start = performance.now();
    const queue = this.buildQueue;
    const bestCost = this.buildBestCost;
    const bestSource = this.buildBestSource;
    const coarseCost = this.buildCoarseCost;
    const coarseLand = this.buildCoarseLand;
    const coarseWidth = this.buildWidth;
    const coarseHeight = this.buildHeight;

    const buildStart = FrameProfiler.start();
    while (queue.size() > 0 && performance.now() - start < budgetMs) {
      const entry = queue.pop();
      if (!entry || entry.cost !== bestCost[entry.tile]) {
        continue;
      }
      this.forEachCoarseNeighbor(
        entry.tile,
        coarseWidth,
        coarseHeight,
        (neighbor) => {
          if (!coarseLand[neighbor]) {
            return;
          }
          const nextCost = entry.cost + coarseCost[neighbor];
          if (nextCost < bestCost[neighbor]) {
            bestCost[neighbor] = nextCost;
            bestSource[neighbor] = entry.sourceIndex;
            queue.push({
              tile: neighbor,
              cost: nextCost,
              sourceIndex: entry.sourceIndex,
            });
          }
        },
      );
    }
    FrameProfiler.end("TerritoryLayer:spawnOverlay:buildStep", buildStart);

    if (this.buildSources) {
      const now = performance.now();
      if (now - this.lastPaintMs >= this.paintIntervalMs) {
        this.paintOverlay(
          bestSource,
          this.buildSources,
          coarseWidth,
          coarseHeight,
          this.cellSize,
        );
        this.lastPaintMs = now;
      }
    }

    if (queue.size() === 0) {
      this.finishBuild();
    }
  }

  private finishBuild() {
    if (
      !this.buildSources ||
      !this.buildBestSource ||
      !this.buildKey ||
      !this.buildKeySet
    ) {
      return;
    }
    this.paintOverlay(
      this.buildBestSource,
      this.buildSources,
      this.buildWidth,
      this.buildHeight,
      this.cellSize,
    );
    this.key = this.buildKey;
    this.keySet = this.buildKeySet;
    this.lastUpdateMs = performance.now();
    this.buildQueue = null;
    this.buildSources = null;
    this.buildBestCost = null;
    this.buildBestSource = null;
    this.buildCoarseCost = null;
    this.buildCoarseLand = null;
    this.buildWidth = 0;
    this.buildHeight = 0;
    this.buildKey = null;
    this.buildKeySet = null;
  }

  private paintOverlay(
    bestSource: Int32Array,
    sources: SpawnClaimSource[],
    coarseWidth: number,
    coarseHeight: number,
    scale: number,
  ) {
    const paintStart = FrameProfiler.start();
    const ctx = this.context;
    ctx.clearRect(0, 0, this.game.width(), this.game.height());
    const imageData = ctx.createImageData(
      this.game.width(),
      this.game.height(),
    );
    const data = imageData.data;
    const fullWidth = this.game.width();
    const fullHeight = this.game.height();
    const totalCoarse = coarseWidth * coarseHeight;
    for (let cell = 0; cell < totalCoarse; cell++) {
      const sourceIndex = bestSource[cell];
      if (sourceIndex < 0) {
        continue;
      }
      const color = sources[sourceIndex].color;
      const baseX = (cell % coarseWidth) * scale;
      const baseY = Math.floor(cell / coarseWidth) * scale;
      for (let dy = 0; dy < scale; dy++) {
        const y = baseY + dy;
        if (y >= fullHeight) continue;
        const rowOffset = y * fullWidth;
        for (let dx = 0; dx < scale; dx++) {
          const x = baseX + dx;
          if (x >= fullWidth) continue;
          const offset = (rowOffset + x) * 4;
          data[offset] = color.rgba.r;
          data[offset + 1] = color.rgba.g;
          data[offset + 2] = color.rgba.b;
          data[offset + 3] = this.alpha;
        }
      }
    }

    const myTeam = this.game.myPlayer()?.team() ?? null;
    if (myTeam !== null) {
      const sameTeamBySource = sources.map((source) => source.team === myTeam);
      const total = coarseWidth * coarseHeight;
      const borderMask = this.buildCoarseBorderMask(
        bestSource,
        sameTeamBySource,
        coarseWidth,
        coarseHeight,
      );
      const borderR = 255;
      const borderG = 230;
      const borderB = 120;
      const borderA = 230;
      const borderRadius = 1;

      if (borderRadius > 0) {
        for (let cell = 0; cell < total; cell++) {
          if (borderMask[cell] !== 1) {
            continue;
          }
          const x = cell % coarseWidth;
          const y = Math.floor(cell / coarseWidth);
          for (let dy = -borderRadius; dy <= borderRadius; dy++) {
            const ny = y + dy;
            if (ny < 0) continue;
            if (ny >= coarseHeight) continue;
            const rowOffset = ny * coarseWidth;
            for (let dx = -borderRadius; dx <= borderRadius; dx++) {
              const nx = x + dx;
              if (nx < 0 || nx >= coarseWidth) continue;
              const target = rowOffset + nx;
              const baseX = (target % coarseWidth) * scale;
              const baseY = Math.floor(target / coarseWidth) * scale;
              for (let bdy = 0; bdy < scale; bdy++) {
                const py = baseY + bdy;
                if (py >= fullHeight) continue;
                const row = py * fullWidth;
                for (let bdx = 0; bdx < scale; bdx++) {
                  const px = baseX + bdx;
                  if (px >= fullWidth) continue;
                  const offset = (row + px) * 4;
                  data[offset] = borderR;
                  data[offset + 1] = borderG;
                  data[offset + 2] = borderB;
                  data[offset + 3] = borderA;
                }
              }
            }
          }
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);
    FrameProfiler.end("TerritoryLayer:spawnOverlay:paint", paintStart);
  }

  private clearOverlay() {
    this.context.clearRect(0, 0, this.game.width(), this.game.height());
  }

  private buildCoarseGrid(
    scale: number,
    width: number,
    height: number,
  ): {
    coarseWidth: number;
    coarseHeight: number;
    coarseCost: Float32Array;
    coarseLand: Uint8Array;
  } {
    const coarseWidth = Math.ceil(width / scale);
    const coarseHeight = Math.ceil(height / scale);
    const totalCoarse = coarseWidth * coarseHeight;
    const coarseCost = new Float32Array(totalCoarse);
    const coarseLand = new Uint8Array(totalCoarse);

    for (let cy = 0; cy < coarseHeight; cy++) {
      for (let cx = 0; cx < coarseWidth; cx++) {
        let minCost = Number.POSITIVE_INFINITY;
        let hasLand = false;
        const baseX = cx * scale;
        const baseY = cy * scale;
        for (let dy = 0; dy < scale; dy++) {
          const y = baseY + dy;
          if (y >= height) continue;
          for (let dx = 0; dx < scale; dx++) {
            const x = baseX + dx;
            if (x >= width) continue;
            const tile = this.game.ref(x, y);
            if (this.game.isLand(tile)) {
              hasLand = true;
              const cost = this.spawnClaimCost(tile);
              if (cost < minCost) {
                minCost = cost;
              }
            }
          }
        }
        const index = cy * coarseWidth + cx;
        if (hasLand) {
          coarseLand[index] = 1;
          coarseCost[index] = minCost;
        } else {
          coarseLand[index] = 0;
          coarseCost[index] = 1;
        }
      }
    }

    return { coarseWidth, coarseHeight, coarseCost, coarseLand };
  }

  private forEachCoarseNeighbor(
    cell: number,
    width: number,
    height: number,
    cb: (neighbor: number) => void,
  ) {
    const x = cell % width;
    const y = Math.floor(cell / width);
    if (x > 0) cb(cell - 1);
    if (x < width - 1) cb(cell + 1);
    if (y > 0) cb(cell - width);
    if (y < height - 1) cb(cell + width);
  }

  private buildCoarseBorderMask(
    bestSource: Int32Array,
    sameTeamBySource: boolean[],
    width: number,
    height: number,
  ): Uint8Array {
    const total = width * height;
    const borderMask = new Uint8Array(total);
    for (let cell = 0; cell < total; cell++) {
      const sourceIndex = bestSource[cell];
      if (sourceIndex < 0 || !sameTeamBySource[sourceIndex]) {
        continue;
      }
      const x = cell % width;
      let isBorder = false;
      if (x === 0 || x === width - 1 || cell < width || cell >= total - width) {
        isBorder = true;
      }
      if (!isBorder && x > 0) {
        const left = bestSource[cell - 1];
        if (left < 0 || !sameTeamBySource[left]) isBorder = true;
      }
      if (!isBorder && x < width - 1) {
        const right = bestSource[cell + 1];
        if (right < 0 || !sameTeamBySource[right]) isBorder = true;
      }
      if (!isBorder && cell >= width) {
        const up = bestSource[cell - width];
        if (up < 0 || !sameTeamBySource[up]) isBorder = true;
      }
      if (!isBorder && cell < total - width) {
        const down = bestSource[cell + width];
        if (down < 0 || !sameTeamBySource[down]) isBorder = true;
      }
      if (isBorder) {
        borderMask[cell] = 1;
      }
    }
    return borderMask;
  }

  private resetBuild(clear: boolean) {
    this.buildQueue = null;
    this.buildSources = null;
    this.buildBestCost = null;
    this.buildBestSource = null;
    this.buildCoarseCost = null;
    this.buildCoarseLand = null;
    this.buildWidth = 0;
    this.buildHeight = 0;
    this.buildKey = null;
    this.buildKeySet = null;
    this.lastPaintMs = 0;
    if (clear) {
      this.clearOverlay();
    }
  }

  private sourceOverlapRatio(
    next: Set<string>,
    prev: Set<string> | null,
  ): number {
    if (!prev || prev.size === 0 || next.size === 0) {
      return 1;
    }
    let shared = 0;
    for (const key of next) {
      if (prev.has(key)) {
        shared++;
      }
    }
    return shared / Math.max(prev.size, next.size);
  }

  private spawnClaimCost(tile: TileRef): number {
    switch (this.game.terrainType(tile)) {
      case TerrainType.Plains:
        return 1;
      case TerrainType.Highland:
        return 1.5;
      case TerrainType.Mountain:
        return 2;
      default:
        return 1;
    }
  }

  private drawOverlay(context: CanvasRenderingContext2D) {
    const x = -this.game.width() / 2;
    const y = -this.game.height() / 2;
    const w = this.game.width();
    const h = this.game.height();

    if (!this.transitionActive) {
      context.drawImage(this.canvas, x, y, w, h);
      return;
    }

    const now = performance.now();
    const progress =
      this.transitionDuration <= 0
        ? 1
        : Math.min(1, (now - this.transitionStart) / this.transitionDuration);
    const previousAlpha = 1 - progress;
    const nextAlpha = progress;

    const previousAlphaCached = context.globalAlpha;
    context.globalAlpha = previousAlphaCached * previousAlpha;
    context.drawImage(this.prevCanvas, x, y, w, h);
    context.globalAlpha = previousAlphaCached * nextAlpha;
    context.drawImage(this.canvas, x, y, w, h);
    context.globalAlpha = previousAlphaCached;

    if (progress >= 1) {
      this.transitionActive = false;
    }
  }
}
