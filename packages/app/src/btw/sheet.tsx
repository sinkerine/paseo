import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useOverlayRegistration } from "@/keyboard";
import { isWeb } from "@/constants/platform";
import { OverlayLayerProvider, useOverlayLayer } from "@/lib/overlay-root";
import { useCallback, type ReactNode } from "react";
import { PaneFocusProvider, usePaneFocus } from "@/panels/pane-context";
import { SheetBackground, SheetHandle, SheetBottomInset } from "@/components/adaptive-modal-sheet";
import {
  IsolatedBottomSheetModal,
  SheetVisibleFrame,
  useIsolatedBottomSheetVisibility,
} from "@/components/ui/isolated-bottom-sheet-modal";

const SNAP_POINTS = ["92%"];
export function BtwSheet({
  visible,
  onHide,
  children,
}: {
  visible: boolean;
  onHide(): void;
  children: ReactNode;
}) {
  const focus = usePaneFocus();
  const contextBridge = useCallback(
    (content: ReactNode) => <PaneFocusProvider value={focus}>{content}</PaneFocusProvider>,
    [focus],
  );
  const layer = useOverlayLayer("modal");
  const scope = useOverlayRegistration({
    active: visible && isWeb,
    layer,
    keys: ["Escape"],
    onKeyDown: (event) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      event.stopPropagation();
      onHide();
      return true;
    },
  });
  const { sheetRef, handleSheetChange, handleSheetDismiss } = useIsolatedBottomSheetVisibility({
    visible,
    onClose: onHide,
  });
  return (
    <IsolatedBottomSheetModal
      ref={sheetRef}
      contextBridge={contextBridge}
      snapPoints={SNAP_POINTS}
      index={0}
      enableDynamicSizing={false}
      enablePanDownToClose
      backdropOpacity={0.45}
      onChange={handleSheetChange}
      onDismiss={handleSheetDismiss}
      backgroundComponent={SheetBackground}
      handleComponent={SheetHandle}
      keyboardBehavior="extend"
      keyboardBlurBehavior="restore"
    >
      <OverlayLayerProvider layer={layer}>
        <SheetVisibleFrame>
          <SheetBottomInset style={styles.body}>
            <View ref={scope} style={styles.body}>
              {children}
            </View>
          </SheetBottomInset>
        </SheetVisibleFrame>
      </OverlayLayerProvider>
    </IsolatedBottomSheetModal>
  );
}

const styles = StyleSheet.create({ body: { flex: 1, minHeight: 0 } });
