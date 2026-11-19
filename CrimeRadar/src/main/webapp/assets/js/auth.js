// Login screen: sign in, create an account, or open the demo account.

import { $, busy, fmt } from './ui.js';
import { auth, DEMO, getMode } from './api.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class LoginView {
  constructor({ onSignedIn }) {
    this.onSignedIn = onSignedIn;
    this.register = false;
  }

  mount() {
    $('#login-form').addEventListener('submit', (e) => this.submit(e));
    $('#login-demo').addEventListener('click', () => this.demo());
    $('#login-switch').addEventListener('click', () => this.setRegister(!this.register));
  }

  show(model) {
    const meta = model.meta;
    const set = (key, text) => { for (const el of document.querySelectorAll(`[data-stat="${key}"]`)) el.textContent = text; };
    set('incidents', fmt.int(meta.totals.incidents));
    set('years', `${Math.round(meta.dataRange.years)} years`);
    set('hoods', String(model.hoods.length));
    $('#login-range').textContent = `${meta.dataRange.from.slice(0, 4)}–${meta.dataRange.to.slice(0, 4)}`;
    $('.demo-note').textContent = getMode() === 'server'
      ? 'The demo account has a saved Home and Work. It resets at each demo sign-in.'
      : 'Offline mode: accounts you create here last only until this tab closes.';
    $('#login').hidden = false;
    setTimeout(() => $('#login-email').focus(), 50);
  }

  hide() {
    $('#login').hidden = true;
    this.error(null);
  }

  setRegister(on) {
    this.register = on;
    $('#field-name').hidden = !on;
    $('#login-heading').textContent = on ? 'Create your account' : 'Sign in';
    $('#login-sub').textContent = on ? 'Save Home, Work and your route settings.' : 'Your saved places and route settings stay with your account.';
    $('#login-submit').textContent = on ? 'Create account' : 'Sign in';
    $('#login-switch-text').textContent = on ? 'Already have an account?' : 'New to CrimeRadar?';
    $('#login-switch').textContent = on ? 'Sign in' : 'Create an account';
    $('#login-password').setAttribute('autocomplete', on ? 'new-password' : 'current-password');
    this.error(null);
    (on ? $('#login-name') : $('#login-email')).focus();
  }

  error(message, field) {
    const el = $('#login-error');
    el.hidden = !message;
    el.textContent = message || '';
    for (const input of document.querySelectorAll('#login-form input')) input.removeAttribute('aria-invalid');
    if (field) {
      field.setAttribute('aria-invalid', 'true');
      field.focus();
    }
  }

  async submit(e) {
    e.preventDefault();
    const name = $('#login-name').value.trim();
    const email = $('#login-email').value.trim();
    const password = $('#login-password').value;
    if (this.register && !name) return this.error('Please enter your name.', $('#login-name'));
    if (!EMAIL_RE.test(email)) return this.error('Please enter a valid email address.', $('#login-email'));
    if (password.length < 8) return this.error('Use at least 8 characters for the password.', $('#login-password'));
    this.error(null);
    const restore = busy($('#login-submit'), this.register ? 'Creating account…' : 'Signing in…');
    try {
      const user = this.register ? await auth.register(name, email, password) : await auth.login(email, password);
      $('#login-password').value = '';
      this.onSignedIn(user);
    } catch (err) {
      this.error(err.message || 'Something went wrong. Try again.');
    } finally {
      restore();
    }
  }

  async demo() {
    const restore = busy($('#login-demo'), 'Opening the demo…');
    try {
      const user = await auth.login(DEMO.email, DEMO.password);
      this.onSignedIn(user);
    } catch (err) {
      this.error(err.status === 401 && getMode() === 'server'
        ? 'The demo account is not set up on this server yet. Run scripts/setup-db.ps1, then try again.'
        : err.message || 'Could not open the demo account.');
    } finally {
      restore();
    }
  }
}
