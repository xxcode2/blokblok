// Grid / edge-model tests (DEVELOPMENT.md edge convention).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  blockadeEdges,
  edgeForMove,
  isMoveBlocked,
  isValidBlockade,
  isValidCell,
  isValidEdge,
  neighbour,
  pathExists,
  shortestDistance,
  shortestPath,
} from "../index.js";

const N = 12;

describe("edge validity", () => {
  it("h edges are valid only for 1<=row<N, 0<=col<N", () => {
    assert.equal(isValidEdge({ row: 0, col: 0, orientation: "h" }, N), false);
    assert.equal(isValidEdge({ row: 1, col: 0, orientation: "h" }, N), true);
    assert.equal(isValidEdge({ row: 11, col: 11, orientation: "h" }, N), true);
    assert.equal(isValidEdge({ row: 12, col: 0, orientation: "h" }, N), false);
    assert.equal(isValidEdge({ row: 5, col: 12, orientation: "h" }, N), false);
  });

  it("v edges are valid only for 0<=row<N, 1<=col<N", () => {
    assert.equal(isValidEdge({ row: 0, col: 0, orientation: "v" }, N), false);
    assert.equal(isValidEdge({ row: 0, col: 1, orientation: "v" }, N), true);
    assert.equal(isValidEdge({ row: 11, col: 11, orientation: "v" }, N), true);
    assert.equal(isValidEdge({ row: 0, col: 12, orientation: "v" }, N), false);
  });

  it("blockade edges expand along the line", () => {
    assert.deepEqual(
      blockadeEdges({ row: 5, col: 2, orientation: "h", len: 3 }).map((e) => [e.row, e.col, e.orientation]),
      [
        [5, 2, "h"],
        [5, 3, "h"],
        [5, 4, "h"],
      ],
    );
    assert.deepEqual(
      blockadeEdges({ row: 3, col: 4, orientation: "v", len: 2 }).map((e) => [e.row, e.col, e.orientation]),
      [
        [3, 4, "v"],
        [4, 4, "v"],
      ],
    );
  });

  it("blockade validity rejects bad lengths and out-of-grid spans", () => {
    assert.equal(isValidBlockade({ row: 5, col: 5, orientation: "h", len: 0 }, N), false);
    assert.equal(isValidBlockade({ row: 5, col: 5, orientation: "h", len: 5 }, N), false);
    assert.equal(isValidBlockade({ row: 11, col: 10, orientation: "h", len: 3 }, N), false); // col 12 out
    assert.equal(isValidBlockade({ row: 11, col: 9, orientation: "h", len: 3 }, N), true);
    assert.equal(isValidBlockade({ row: 0, col: 5, orientation: "h", len: 1 }, N), false);
  });
});

describe("movement blocking", () => {
  it("an h edge blocks up from below and down from above", () => {
    const edges = new Set(["h:5:3"]);
    assert.equal(isMoveBlocked({ row: 5, col: 3 }, "up", edges, N), true);
    assert.equal(isMoveBlocked({ row: 4, col: 3 }, "down", edges, N), true);
    assert.equal(isMoveBlocked({ row: 5, col: 4 }, "up", edges, N), false);
    assert.equal(isMoveBlocked({ row: 5, col: 3 }, "down", edges, N), false);
  });

  it("a v edge blocks left/right across it", () => {
    const edges = new Set(["v:7:4"]);
    assert.equal(isMoveBlocked({ row: 7, col: 4 }, "left", edges, N), true);
    assert.equal(isMoveBlocked({ row: 7, col: 3 }, "right", edges, N), true);
    assert.equal(isMoveBlocked({ row: 7, col: 4 }, "right", edges, N), false);
  });

  it("grid borders block movement", () => {
    const edges = new Set<string>();
    assert.equal(isMoveBlocked({ row: 0, col: 5 }, "up", edges, N), true);
    assert.equal(isMoveBlocked({ row: 11, col: 5 }, "down", edges, N), true);
    assert.equal(isMoveBlocked({ row: 5, col: 0 }, "left", edges, N), true);
    assert.equal(isMoveBlocked({ row: 5, col: 11 }, "right", edges, N), true);
    assert.equal(isMoveBlocked({ row: 5, col: 5 }, "up", edges, N), false);
  });

  it("edgeForMove returns the crossed edge", () => {
    assert.deepEqual(edgeForMove({ row: 5, col: 3 }, "up", N), { row: 5, col: 3, orientation: "h" });
    assert.deepEqual(edgeForMove({ row: 5, col: 3 }, "down", N), { row: 6, col: 3, orientation: "h" });
    assert.deepEqual(edgeForMove({ row: 5, col: 3 }, "left", N), { row: 5, col: 3, orientation: "v" });
    assert.deepEqual(edgeForMove({ row: 5, col: 3 }, "right", N), { row: 5, col: 4, orientation: "v" });
    assert.equal(edgeForMove({ row: 0, col: 3 }, "up", N), null);
    assert.equal(isValidCell(0, 0, N), true);
    assert.equal(isValidCell(12, 0, N), false);
    assert.deepEqual(neighbour({ row: 5, col: 5 }, "up"), { row: 4, col: 5 });
  });
});

describe("BFS pathfinding", () => {
  it("empty grid: shortest path to goal row is the row distance", () => {
    assert.equal(shortestDistance({ row: 11, col: 6 }, 0, new Set(), N), 11);
    assert.equal(shortestDistance({ row: 0, col: 6 }, 11, new Set(), N), 11);
    assert.deepEqual(shortestPath({ row: 2, col: 6 }, 0, new Set(), N), ["up", "up"]);
    assert.equal(pathExists({ row: 11, col: 6 }, 0, new Set(), N), true);
  });

  it("a full horizontal wall seals the goal off", () => {
    const wall = new Set<string>();
    for (let c = 0; c < N; c++) wall.add(`h:6:${c}`);
    assert.equal(pathExists({ row: 11, col: 6 }, 0, wall, N), false);
    assert.equal(shortestDistance({ row: 11, col: 6 }, 0, wall, N), null);
    // One gap reopens the path (detour costs extra steps).
    wall.delete("h:6:0");
    assert.equal(pathExists({ row: 11, col: 6 }, 0, wall, N), true);
    assert.ok((shortestDistance({ row: 11, col: 6 }, 0, wall, N) ?? 0) > 11);
  });

  it("a wall with a detour still routes around it", () => {
    const wall = new Set<string>();
    for (let c = 2; c < 10; c++) wall.add(`h:6:${c}`);
    const d = shortestDistance({ row: 11, col: 6 }, 0, wall, N);
    assert.ok(d !== null && d > 11);
  });
});
