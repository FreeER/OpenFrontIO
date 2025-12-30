import { colord } from "colord";
import { SpawnClaimOverlay } from "../../../src/client/graphics/layers/SpawnClaimOverlay";
import { GameMode, PlayerType, TerrainType } from "../../../src/core/game/Game";

const makeContext = () => {
  return {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    createImageData: (w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: vi.fn(),
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
};

const createGame = (players: any[], width = 12, height = 12) => {
  const config = {
    gameConfig: () => ({ gameMode: GameMode.Team }),
  };
  return {
    width: () => width,
    height: () => height,
    config: () => config,
    playerViews: () => players,
    myPlayer: () => players[0] ?? null,
    ref: (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return null;
      return y * width + x;
    },
    x: (tile: number) => tile % width,
    y: (tile: number) => Math.floor(tile / width),
    isLand: (_tile: number) => true,
    terrainType: (_tile: number) => TerrainType.Plains,
  } as any;
};

const createPlayer = (
  id: string,
  team: string | null,
  type: PlayerType,
  loc: { x: number; y: number; size: number },
) => {
  return {
    id: () => id,
    team: () => team,
    type: () => type,
    nameLocation: () => loc,
  } as any;
};

describe("SpawnClaimOverlay", () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  let now = 0;
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => {
    ctx = makeContext();
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    HTMLCanvasElement.prototype.getContext = vi
      .fn()
      .mockImplementation(() => ctx);
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    vi.restoreAllMocks();
  });

  it("keeps small moves stable until the threshold is exceeded", () => {
    const loc = { x: 2, y: 2, size: 1 };
    const player = createPlayer("p1", "Red", PlayerType.Human, loc);
    const game = createGame([player]);
    const theme = {
      teamColor: () => colord("#ff0000"),
      territoryColor: () => colord("#999999"),
    } as any;

    const overlay = new SpawnClaimOverlay(game, theme);

    now = 0;
    overlay.update();
    now = 250;
    overlay.update();

    loc.x = 4; // small move (<=6 tiles)
    now = 500;
    overlay.update();

    let positions = (overlay as any).sourcePositions as Map<
      string,
      { x: number; y: number }
    >;
    expect(positions.get("p1")).toEqual({ x: 2, y: 2 });

    loc.x = 10; // large move
    now = 800;
    overlay.update();
    positions = (overlay as any).sourcePositions as Map<
      string,
      { x: number; y: number }
    >;
    expect(positions.get("p1")).toEqual({ x: 10, y: 2 });
  });

  it("builds and renders an overlay", () => {
    const locA = { x: 1, y: 1, size: 1 };
    const locB = { x: 9, y: 9, size: 1 };
    const playerA = createPlayer("p1", "Red", PlayerType.Human, locA);
    const playerB = createPlayer("p2", "Blue", PlayerType.Human, locB);
    const game = createGame([playerA, playerB]);
    const theme = {
      teamColor: () => colord("#ff0000"),
      territoryColor: () => colord("#999999"),
    } as any;

    const overlay = new SpawnClaimOverlay(game, theme);

    for (let i = 0; i < 20; i++) {
      now += 50;
      overlay.update();
    }

    const renderCtx = makeContext();
    overlay.render(renderCtx);

    expect(ctx.putImageData).toHaveBeenCalled();
    expect(renderCtx.drawImage).toHaveBeenCalled();
  });
});
