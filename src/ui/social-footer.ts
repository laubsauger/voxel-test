/**
 * Subtle socials footer (shared by the main menu + pause screen). Pure links,
 * no app state. Glows to each brand's hue on hover. Vanilla port of the
 * user-supplied React component — ui-root is pointer-events-none, each link
 * opts back in.
 */

const LINKS: { href: string; label: string; hover: string; glow: string; svg: string }[] = [
  {
    href: 'https://www.instagram.com/floflup',
    label: 'Instagram',
    hover: '#ff2fd6',
    glow: 'rgba(255,47,214,0.8)',
    svg: '<rect width="20" height="20" x="2" y="2" rx="5" ry="5"/><path d="M16.11 7.5v.01"/><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/>',
  },
  {
    href: 'https://github.com/laubsauger',
    label: 'GitHub',
    hover: '#ffffff',
    glow: 'rgba(255,255,255,0.8)',
    svg: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
  },
  {
    href: 'https://www.youtube.com/@laub69',
    label: 'YouTube',
    hover: '#ff0000',
    glow: 'rgba(255,0,0,0.8)',
    svg: '<path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17"/><path d="m10 15 5-3-5-3z"/>',
  },
]

/** build the footer element — caller appends (bottom-center of menu/pause) */
export function createSocialFooter(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'bb-social-footer'
  for (const l of LINKS) {
    const a = document.createElement('a')
    a.href = l.href
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    a.setAttribute('aria-label', l.label)
    a.className = 'bb-social-link'
    a.style.setProperty('--hover-color', l.hover)
    a.style.setProperty('--hover-glow', l.glow)
    a.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${l.svg}</svg>`
    el.appendChild(a)
  }
  return el
}
