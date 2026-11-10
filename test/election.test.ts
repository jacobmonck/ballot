import { describe, expect, it } from "vitest";
import { countRound, majority } from "../src/worker/election";

describe("majority", () => {
  it("is more than half the ballots", () => {
    expect(majority(10)).toBe(6);
    expect(majority(9)).toBe(5);
    expect(majority(0)).toBe(1);
  });
});

describe("countRound", () => {
  it("elects a 1-seat majority winner", () => {
    const outcome = countRound({
      seatsOpen: 1,
      ballots: 10,
      candidates: [
        { id: "A", picks: 6 },
        { id: "B", picks: 3 },
        { id: "C", picks: 1 },
      ],
    });
    expect(outcome).toEqual({ elected: ["A"], nextBallot: [], decided: true });
  });

  it("does not treat exactly half as a majority", () => {
    const outcome = countRound({
      seatsOpen: 1,
      ballots: 10,
      candidates: [
        { id: "A", picks: 5 },
        { id: "B", picks: 5 },
      ],
    });
    expect(outcome).toEqual({ elected: [], nextBallot: ["A", "B"], decided: false });
  });

  it("drops last place when nobody clears", () => {
    const outcome = countRound({
      seatsOpen: 1,
      ballots: 10,
      candidates: [
        { id: "A", picks: 4 },
        { id: "B", picks: 3 },
        { id: "C", picks: 2 },
        { id: "D", picks: 1 },
      ],
    });
    expect(outcome).toEqual({ elected: [], nextBallot: ["A", "B", "C"], decided: false });
  });

  it("drops everyone tied for last", () => {
    const outcome = countRound({
      seatsOpen: 1,
      ballots: 10,
      candidates: [
        { id: "A", picks: 4 },
        { id: "B", picks: 4 },
        { id: "C", picks: 1 },
        { id: "D", picks: 1 },
      ],
    });
    expect(outcome).toEqual({ elected: [], nextBallot: ["A", "B"], decided: false });
  });

  it("elects the leader when dropping the tied last leaves only them", () => {
    const outcome = countRound({
      seatsOpen: 1,
      ballots: 10,
      candidates: [
        { id: "A", picks: 4 },
        { id: "B", picks: 3 },
        { id: "C", picks: 3 },
      ],
    });
    expect(outcome).toEqual({ elected: ["A"], nextBallot: [], decided: true });
  });

  it("2-seat: both clear", () => {
    const outcome = countRound({
      seatsOpen: 2,
      ballots: 10,
      candidates: [
        { id: "A", picks: 7 },
        { id: "B", picks: 6 },
        { id: "C", picks: 3 },
      ],
    });
    expect(outcome).toEqual({ elected: ["A", "B"], nextBallot: [], decided: true });
  });

  it("2-seat: one clears, runoff for the other", () => {
    const outcome = countRound({
      seatsOpen: 2,
      ballots: 10,
      candidates: [
        { id: "A", picks: 8 },
        { id: "B", picks: 4 },
        { id: "C", picks: 3 },
        { id: "D", picks: 2 },
      ],
    });
    expect(outcome).toEqual({ elected: ["A"], nextBallot: ["B", "C"], decided: false });
  });

  it("2-seat: dropping leaves as many as seats, so they win", () => {
    const outcome = countRound({
      seatsOpen: 2,
      ballots: 10,
      candidates: [
        { id: "A", picks: 5 },
        { id: "B", picks: 4 },
        { id: "C", picks: 2 },
      ],
    });
    expect(outcome).toEqual({ elected: ["A", "B"], nextBallot: [], decided: true });
  });

  it("tie at the last seat among clearers revotes only the tied", () => {
    const outcome = countRound({
      seatsOpen: 2,
      ballots: 10,
      candidates: [
        { id: "A", picks: 9 },
        { id: "B", picks: 7 },
        { id: "C", picks: 7 },
        { id: "D", picks: 1 },
      ],
    });
    expect(outcome).toEqual({ elected: ["A"], nextBallot: ["B", "C"], decided: false });
  });

  it("zero ballots revotes everyone", () => {
    const outcome = countRound({
      seatsOpen: 1,
      ballots: 0,
      candidates: [
        { id: "A", picks: 0 },
        { id: "B", picks: 0 },
        { id: "C", picks: 0 },
      ],
    });
    expect(outcome).toEqual({ elected: [], nextBallot: ["A", "B", "C"], decided: false });
  });
});
