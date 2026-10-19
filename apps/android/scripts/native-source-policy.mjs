/**
 * Source-level rules for the native shell, checked without an Android SDK.
 *
 * The artifact scan (`verify-artifacts.mjs`) runs them on the sources it packages, and the node
 * test suite runs them on the checked-in sources, so a regression shows up on any machine before
 * a Gradle build is attempted.
 */

/**
 * System Back must walk the web app's history: an `OnBackPressedCallback` registered on the
 * activity's dispatcher goes back in the WebView while it can, and otherwise hands the press to
 * the system by disabling itself for that one dispatch.
 */
export function backNavigationProblems(mainActivitySource) {
  const problems = [];
  const has = (pattern) => pattern.test(mainActivitySource);
  if (!has(/import\s+androidx\.activity\.OnBackPressedCallback\s*;/u)) {
    problems.push("MainActivity does not import androidx.activity.OnBackPressedCallback");
  }
  if (!has(/getOnBackPressedDispatcher\(\)\s*\.addCallback\(\s*this\s*,\s*new\s+\w+\(\)\s*\)/u)) {
    problems.push("MainActivity does not register a back callback with its lifecycle");
  }
  if (!has(/extends\s+OnBackPressedCallback/u) || !has(/super\(\s*true\s*\)/u)) {
    problems.push("the back callback is missing or not enabled");
  }
  if (!has(/if\s*\(\s*webView\s*!=\s*null\s*&&\s*webView\.canGoBack\(\)\s*\)\s*\{\s*webView\.goBack\(\);\s*return;\s*\}/u)) {
    problems.push("the back callback does not walk the WebView history while it can");
  }
  if (!has(/setEnabled\(false\);\s*getOnBackPressedDispatcher\(\)\.onBackPressed\(\);\s*setEnabled\(true\);/u)) {
    problems.push("the back callback does not hand an exhausted history back to the system");
  }
  if (has(/\bfinish\(\)|System\.exit/u)) {
    problems.push("MainActivity must not finish the app itself on Back");
  }
  return problems;
}
