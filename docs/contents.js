// The docs' contents (docs/app.html): folded on a narrow screen. A file, not a script in the page,
// so the page's policy can refuse inline scripts (public/_headers).
{
  // The contents start folded, so the page comes first.
  // Following a link there folds them again.
  const narrow = matchMedia("(max-width: 800px)");
  const contents = document.querySelector(".contents details");
  if (narrow.matches) contents.open = false;
  // On a wide screen they can't be folded (the summary is hidden), so widening opens them again.
  narrow.addEventListener("change", () => {
    if (!narrow.matches) contents.open = true;
  });
  contents.addEventListener("click", (event) => {
    if (narrow.matches && event.composedPath().some((el) => el instanceof HTMLAnchorElement)) contents.open = false;
  });
}
