(() => {
	// Optional extension point for future camera-based QR scanning in the PWA.
	window.SidecarQrScanner = {
		isSupported() {
			return false;
		}
	};
})();
