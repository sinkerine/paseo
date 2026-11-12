import type { ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { useOverlayRegistration } from "@/keyboard";
import { OverlayLayerProvider, useOverlayLayer } from "@/lib/overlay-root";

export function BtwFloatingCard({
  visible,
  onHide,
  children,
}: {
  visible: boolean;
  onHide(): void;
  children: ReactNode;
}) {
  const layer = useOverlayLayer("floating");
  const scope = useOverlayRegistration({
    active: visible && isWeb,
    layer,
    keys: ["Escape"],
    manageFocus: false,
    onKeyDown: (event) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      event.stopPropagation();
      onHide();
      return true;
    },
  });
  if (!visible) return null;
  return (
    <View style={styles.position} pointerEvents="box-none">
      <View ref={scope} style={styles.card} testID="btw-floating-card">
        <OverlayLayerProvider layer={layer}>{children}</OverlayLayerProvider>
      </View>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  position: {
    position: "absolute",
    bottom: 56,
    left: theme.spacing[4],
    right: theme.spacing[4],
    height: "60%",
    alignItems: "flex-end",
    zIndex: 10,
  },
  card: {
    width: 440,
    maxWidth: "100%",
    flex: 1,
    minHeight: 0,
    zIndex: 10,
    overflow: "hidden",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface0,
  },
}));
