"use client";

import { createContext, useContext, type ReactNode } from "react";

const BASE_MODAL_Z_INDEX = 1000;
const MODAL_LAYER_STEP = 10;

const ModalLayerContext = createContext(BASE_MODAL_Z_INDEX);

export function useModalLayerZIndex() {
  return useContext(ModalLayerContext);
}

export function getNextModalLayerZIndex(parentZIndex: number) {
  return parentZIndex + MODAL_LAYER_STEP;
}

export function ModalLayerProvider({ value, children }: { value: number; children: ReactNode }) {
  return <ModalLayerContext.Provider value={value}>{children}</ModalLayerContext.Provider>;
}
