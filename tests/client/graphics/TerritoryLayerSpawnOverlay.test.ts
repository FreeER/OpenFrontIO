import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerritoryLayer } from "../../../src/client/graphics/layers/TerritoryLayer";

const makeContext = () => {
  return {
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
};

describe("TerritoryLayer spawn overlay gating", () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = vi
      .fn()
      .mockImplementation(() => makeContext());
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    vi.restoreAllMocks();
  });

  const createLayer = (spawnPhaseRef: { value: boolean }) => {
    const game = {
      width: () => 4,
      height: () => 4,
      config: () => ({ theme: () => ({}) }),
      inSpawnPhase: () => spawnPhaseRef.value,
      forEachTile: (_cb: (tile: number) => void) => {},
      recentlyUpdatedTiles: () => [],
      updatesSinceLastTick: () => null,
      focusedPlayer: () => null,
      ticks: () => 0,
      myPlayer: () => null,
      playerViews: () => [],
      ref: (x: number, y: number) => y * 4 + x,
      hasOwner: () => false,
      owner: () => null,
      hasFallout: () => false,
      neighbors: () => [],
      ownerID: () => null,
      isBorder: () => false,
      bfs: () => [],
      isValidCoord: () => true,
    } as any;
    const eventBus = { on: vi.fn() } as any;
    const transformHandler = {
      screenBoundingRect: () => [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
      screenToWorldCoordinates: (x: number, y: number) => ({ x, y }),
    } as any;
    const userSettings = {} as any;
    const layer = new TerritoryLayer(
      game,
      eventBus,
      transformHandler,
      userSettings,
    );
    const spawnOverlay = {
      update: vi.fn(),
      render: vi.fn(),
      resize: vi.fn(),
      activate: vi.fn(),
      deactivate: vi.fn(),
    };
    (layer as any).spawnOverlay = spawnOverlay;
    layer.redraw();
    return { layer, spawnOverlay };
  };

  it("skips spawn overlay render/update outside spawn phase", () => {
    const spawnPhaseRef = { value: false };
    const { layer, spawnOverlay } = createLayer(spawnPhaseRef);
    const renderContext = makeContext();

    layer.renderLayer(renderContext);
    expect(spawnOverlay.update).not.toHaveBeenCalled();
    expect(spawnOverlay.render).not.toHaveBeenCalled();

    spawnPhaseRef.value = true;
    layer.renderLayer(renderContext);
    expect(spawnOverlay.update).toHaveBeenCalledTimes(1);
    expect(spawnOverlay.render).toHaveBeenCalledTimes(1);
  });

  it("deactivates spawn overlay when leaving spawn phase", () => {
    const spawnPhaseRef = { value: true };
    const { layer, spawnOverlay } = createLayer(spawnPhaseRef);

    layer.tick();
    expect(spawnOverlay.activate).toHaveBeenCalledTimes(1);

    spawnPhaseRef.value = false;
    layer.tick();
    expect(spawnOverlay.deactivate).toHaveBeenCalledTimes(1);
  });
});
