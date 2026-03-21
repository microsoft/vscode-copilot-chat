from playwright.sync_api import sync_playwright

def verify():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.set_content("""
        <!DOCTYPE html>
        <html>
        <head>
          <script type="module" src="https://cdn.jsdelivr.net/npm/@vscode/webview-ui-toolkit@1.4.0/dist/toolkit.min.js"></script>
        </head>
        <body style="background-color: #1e1e1e; color: white; padding: 20px;">
          <div id="solutionsContainer">
            <vscode-button role="button" class="acceptButton" id="acceptButton0" appearance="secondary" data-solution-index="0" title="Accept suggestion 1">Accept suggestion 1</vscode-button>
          </div>
        </body>
        </html>
        """)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1000)
        page.hover("#acceptButton0")
        page.wait_for_timeout(500)
        page.screenshot(path="verification.png")
        browser.close()

if __name__ == "__main__":
    verify()
