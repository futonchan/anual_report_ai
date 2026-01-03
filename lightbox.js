export function initLightbox({ els, images }) {
  if (!els?.container || !els?.img) return null;
  let index = 0;

  const update = (nextIndex) => {
    index = ((nextIndex % images.length) + images.length) % images.length;
    els.img.src = images[index];
    if (els.step) {
      els.step.textContent = `手順 ${index + 1}/${images.length}`;
    }
  };

  const show = (idx = 0) => {
    update(idx);
    els.container.classList.remove("hidden");
    els.container.setAttribute("aria-hidden", "false");
  };

  const hide = () => {
    els.container.classList.add("hidden");
    els.container.setAttribute("aria-hidden", "true");
  };

  const step = (delta) => show(index + delta);

  if (els.close) els.close.addEventListener("click", hide);
  if (els.prev) els.prev.addEventListener("click", () => step(-1));
  if (els.next) els.next.addEventListener("click", () => step(1));
  if (els.backdrop) els.backdrop.addEventListener("click", hide);

  return { show, hide, step };
}
