/* ============================================================================
 * SPORTINGSTREAM — Synthetiq Player (contract v4, live)
 * ----------------------------------------------------------------------------
 * Live sport: sportingstream.site publishes one public JSON snapshot at
 * /api/public (categories, channels, live streams and a seven-day EPG). Every
 * channel carries a public source (has_url=1); the source is only handed out
 * through the site's own signed flow:
 *   GET /api/stream-token/<channelId>  -> { t }
 *   GET /api/stream/<channelId>?t=...  -> { urls: [1-3 proxied HLS playlists] }
 * The playlists are live media playlists on northlive.lol's proxy and accept a
 * plain browser user agent. The module answers with isLive=true, so the app
 * keeps live-safe playback (no resume, no download, no seek, bounded retry).
 *
 * One card = one channel; an EPG entry gets its own card (href keeps the
 * programme id) so a fiche can describe what is on, while playback always
 * resolves the channel's live source. No auth, token, stats provider, DRM or
 * paywall is bypassed; only the public endpoints the site itself calls.
 * ==========================================================================*/

(function () {
  'use strict';

  var SITE = 'https://sportingstream.site';
  var API = SITE + '/api';
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

  var JSON_HEADERS = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'fr-FR,fr;q=0.9',
    'Referer': SITE + '/'
  };
  /* northlive's proxy answers any user agent; a foreign Referer is pointless
   * there, so the player only sends the same browser UA. */
  var STREAM_HEADERS = { 'User-Agent': UA, 'Accept': '*/*' };

  /* /api/public is the site's own 30 s snapshot (about 170 KB): eight
   * categories, 31 channels and a seven-day EPG. Home, a fiche and an episode
   * list all read the same snapshot, so it is kept briefly instead of being
   * downloaded three times for one screen. */
  var DATA_TTL = 45000;
  var dataCache = null;

  /* --------------------------------------------------------------- helpers */
  function now() { return Date.now(); }
  function left(deadline, cap) { return Math.max(600, Math.min(deadline - now(), cap || 10000)); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/<[^>]*>/g, ' ')
      .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* Channel and programme names are matched without accents or case so "ligue"
   * finds "Ligue 1" and "c+ sport" finds "CANAL + SPORT". */
  function norm(s) {
    return String(s == null ? '' : s).normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  function httpsUrl(u) {
    var s = String(u == null ? '' : u).trim();
    return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : '';
  }

  async function fetchJson(url, deadline, cap) {
    var res = await fetchv2(url, JSON_HEADERS, 'GET', null, { timeoutMs: left(deadline, cap) });
    var status = num(res && (res.status || res.statusCode));
    var data = null;
    if (res && typeof res.json === 'function') {
      try { data = await res.json(); } catch (_) { data = null; }
    }
    if (data == null && res && res.json != null) data = res.json;
    if (data == null && res && typeof res.body === 'string' && res.body) {
      try { data = JSON.parse(res.body); } catch (_) { data = null; }
    }
    return { status: status, data: data };
  }

  async function publicData(deadline) {
    if (dataCache && now() - dataCache.at < DATA_TTL) return dataCache.data;
    var r = await fetchJson(API + '/public', deadline, 9000);
    if (r.status === 429) throw new Error('SportingStream : le site limite les requetes (HTTP 429). Reessayez dans une minute.');
    if (r.status !== 200 || !r.data || !Array.isArray(r.data.channels)) {
      throw new Error('SportingStream : catalogue indisponible (HTTP ' + (r.status || '?') + ').');
    }
    var data = {
      categories: Array.isArray(r.data.categories) ? r.data.categories : [],
      channels: r.data.channels,
      streams: Array.isArray(r.data.streams) ? r.data.streams : [],
      programs: Array.isArray(r.data.programs) ? r.data.programs : []
    };
    dataCache = { at: now(), data: data };
    return data;
  }

  /* ------------------------------------------------------------ identities */
  /* Accepted: sportingstream:<channelId>, sportingstream:<channelId>:p<programId>,
   * a site hash (#ch-<id>), a plain channel id, or a channel name. */
  function parseRef(input) {
    var raw = String(input == null ? '' : input).trim();
    if (!raw) return null;
    var m = raw.match(/^sportingstream:(?:channel[-/:]?)?(\d+)(?::p(\d+))?/i);
    if (m) return { id: num(m[1]), programId: num(m[2]) };
    m = raw.match(/(?:#|\/)(?:ch|channel)[-/_]?(\d+)/i);
    if (m) return { id: num(m[1]), programId: 0 };
    m = raw.match(/^(\d+)$/);
    if (m) return { id: num(m[1]), programId: 0 };
    return { name: raw, id: 0, programId: 0 };
  }

  function channelById(data, id) {
    var list = data.channels, i;
    for (i = 0; i < list.length; i++) if (num(list[i].id) === id) return list[i];
    return null;
  }

  function channelByName(data, name) {
    var list = data.channels, i, want = norm(name);
    for (i = 0; i < list.length; i++) if (norm(list[i].name) === want) return list[i];
    return null;
  }

  function channelOf(data, ref) {
    if (ref.id) return channelById(data, ref.id);
    return channelByName(data, ref.name);
  }

  /* ---------------------------------------------------------------- schedule */
  function localDate(dateStr, timeStr) {
    var d = String(dateStr == null ? '' : dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!d) return null;
    var t = String(timeStr == null ? '' : timeStr).match(/^(\d{2}):(\d{2})$/);
    return new Date(num(d[1]), num(d[2]) - 1, num(d[3]), t ? num(t[1]) : 0, t ? num(t[2]) : 0, 0);
  }

  function rangeOf(p) {
    var start = localDate(p && p.date, p && p.start);
    if (!start) return { start: null, end: null };
    var end = localDate(p.date, p.end || '23:59');
    if (p.end && p.start && end <= start) end = new Date(end.getTime() + 86400000);
    return { start: start, end: end };
  }

  function isLiveNow(p, at) {
    var r = rangeOf(p);
    return !!(r.start && at >= r.start && at < r.end);
  }

  function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

  function whenLabel(p, at) {
    var r = rangeOf(p);
    if (!r.start) return '';
    if (at >= r.start && at < r.end) return 'En direct';
    var diff = r.start - at;
    if (diff <= 0) return 'Termine';
    if (diff < 3600000) return 'Dans ' + Math.max(1, Math.round(diff / 60000)) + ' min';
    var days = Math.round((dayStart(r.start) - dayStart(at)) / 86400000);
    if (days <= 0) return "Aujourd'hui " + p.start;
    if (days === 1) return 'Demain ' + p.start;
    var dd = String(r.start.getDate()); if (dd.length < 2) dd = '0' + dd;
    var mm = String(r.start.getMonth() + 1); if (mm.length < 2) mm = '0' + mm;
    return dd + '/' + mm + ' ' + p.start;
  }

  function timeRangeOf(p) {
    var s = clean(p && p.start), e = clean(p && p.end);
    if (!s) return '';
    return s + (e ? '-' + e : '');
  }

  /* Channel EPG: entries are kept in their published order only after sorting
   * by start, because the feed groups them per programme rather than per day. */
  function programsOf(data, ch) {
    var out = [], i, p;
    for (i = 0; i < data.programs.length; i++) {
      p = data.programs[i];
      if (p && norm(p.channel) === norm(ch.name)) out.push(p);
    }
    out.sort(function (a, b) {
      var ra = rangeOf(a).start, rb = rangeOf(b).start;
      return (ra ? ra.getTime() : 0) - (rb ? rb.getTime() : 0);
    });
    return out;
  }

  function liveProgramOf(list, at) {
    var i;
    for (i = 0; i < list.length; i++) if (isLiveNow(list[i], at)) return list[i];
    return null;
  }

  function upcomingOf(list, at, limit) {
    var out = [], i;
    for (i = 0; i < list.length && out.length < limit; i++) {
      var r = rangeOf(list[i]);
      if (r.start && r.start > at) out.push(list[i]);
    }
    return out;
  }

  function liveStreamOf(data, ch) {
    var i, p;
    for (i = 0; i < data.streams.length; i++) {
      p = data.streams[i];
      if (p && p.live && p.channel && norm(p.channel) === norm(ch.name)) return p;
    }
    return null;
  }

  /* ------------------------------------------------------------------ cards */
  function channelHref(ch) { return 'sportingstream:' + num(ch.id); }
  function programHref(ch, p) { return 'sportingstream:' + num(ch.id) + ':p' + num(p.id); }

  function channelCard(ch, at, live) {
    var href = channelHref(ch);
    var card = {
      id: href, href: href, type: 'video',
      title: clean(ch.name),
      image: httpsUrl(ch.logo), poster: httpsUrl(ch.logo)
    };
    if (!card.image) delete card.image;
    if (!card.poster) delete card.poster;
    var category = clean(ch.category);
    if (category) card.genres = [category];
    if (live) {
      card.description = 'En direct : ' + clean(live.title) +
        (timeRangeOf(live) ? ' (' + timeRangeOf(live) + ')' : '') +
        (category ? ' - ' + category : '');
    } else if (category) {
      card.description = category;
    }
    return card;
  }

  function programCard(ch, p, at) {
    var href = programHref(ch, p);
    var logo = httpsUrl(ch.logo);
    var card = {
      id: href, href: href, type: 'video',
      title: clean(p.title) || clean(ch.name)
    };
    if (logo) { card.image = logo; card.poster = logo; }
    var sport = clean(p.sport) || clean(ch.category);
    if (sport) card.genres = [sport];
    var bits = [clean(ch.name)];
    if (whenLabel(p, at)) bits.push(whenLabel(p, at));
    if (timeRangeOf(p)) bits.push(timeRangeOf(p));
    card.description = bits.join(' - ');
    return card;
  }

  function channelsSorted(data) {
    return data.channels.slice().sort(function (a, b) {
      var d = num(a.order) - num(b.order);
      return d || clean(a.name).localeCompare(clean(b.name));
    });
  }

  /* ---------------------------------------------------------------- live tab */
  /* The app's Live tab loads modules that declare
   * config.capabilities.live_discovery_v1 by calling liveHome(). One item is
   * one channel; the app opens it through extractDetails/extractEpisodes with
   * the same id, and playback stays on extractStreamUrl. */
  async function liveHome() {
    var deadline = now() + 7000;
    var data = await publicData(deadline);
    var channels = channelsSorted(data);
    var items = [], i, ch, logo;
    for (i = 0; i < channels.length; i++) {
      ch = channels[i];
      logo = httpsUrl(ch.logo);
      var item = {
        id: channelHref(ch),
        title: clean(ch.name),
        category: clean(ch.category) || 'Direct',
        kind: 'channel',
        language: 'Français',
        status: 'unknown'
      };
      if (logo) item.imageUrl = logo;
      items.push(item);
    }
    return { items: items };
  }

  function withChannels(data) {
    var out = [], i, p, ch;
    for (i = 0; i < data.streams.length; i++) {
      p = data.streams[i];
      ch = p && p.live && p.channel ? channelByName(data, p.channel) : null;
      if (ch) out.push({ channel: ch, program: p });
    }
    for (i = 0; i < data.programs.length; i++) {
      p = data.programs[i];
      ch = p ? channelByName(data, p.channel) : null;
      if (ch) out.push({ channel: ch, program: p });
    }
    return out;
  }

  /* ----------------------------------------------------------------- search */
  async function searchResults(query) {
    var deadline = now() + 15000;
    var data = await publicData(deadline);
    var term = norm(clean(query));
    var out = [], seen = {}, i, ch, list = [];

    if (!term) {
      list = channelsSorted(data).map(function (c) { return channelCard(c, new Date(), null); });
      return list.slice(0, 24);
    }

    /* Channels whose name matches come first. */
    var channels = channelsSorted(data);
    for (i = 0; i < channels.length && out.length < 24; i++) {
      ch = channels[i];
      if (norm(ch.name).indexOf(term) === -1) continue;
      var at = new Date();
      var live = liveProgramOf(programsOf(data, ch), at);
      out.push(channelCard(ch, at, live));
      seen[channelHref(ch)] = true;
    }

    /* Then EPG entries whose title or sport matches; a channel-name match is
     * already covered by the channel card above. Live rows come first. */
    var entries = withChannels(data).filter(function (e) {
      return norm(e.program.title).indexOf(term) !== -1 ||
        norm(e.program.sport).indexOf(term) !== -1;
    });
    entries.sort(function (a, b) {
      var la = isLiveNow(a.program, new Date()) ? 0 : 1;
      var lb = isLiveNow(b.program, new Date()) ? 0 : 1;
      if (la !== lb) return la - lb;
      var ra = rangeOf(a.program).start, rb = rangeOf(b.program).start;
      return (ra ? ra.getTime() : 0) - (rb ? rb.getTime() : 0);
    });
    var cardAt = new Date();
    for (i = 0; i < entries.length && out.length < 24; i++) {
      var href = programHref(entries[i].channel, entries[i].program);
      if (seen[href]) continue;
      seen[href] = true;
      out.push(programCard(entries[i].channel, entries[i].program, cardAt));
    }
    return out;
  }

  /* ---------------------------------------------------------------- details */
  async function extractDetails(urlOrId) {
    var ref = parseRef(urlOrId);
    if (!ref || (!ref.id && !ref.name)) throw new Error('SportingStream : identifiant invalide.');
    var deadline = now() + 15000;
    var data = await publicData(deadline);
    var ch = channelOf(data, ref);
    if (!ch) throw new Error('SportingStream : chaine inconnue.');
    var at = new Date();
    var programs = programsOf(data, ch);
    var live = liveProgramOf(programs, at);
    var soon = upcomingOf(programs, at, 4);
    var category = clean(ch.category);
    var logo = httpsUrl(ch.logo);

    if (ref.programId) {
      var picked = null, i;
      for (i = 0; i < programs.length; i++) if (num(programs[i].id) === ref.programId) picked = programs[i];
      if (picked) {
        var when = whenLabel(picked, at) + (timeRangeOf(picked) ? ' - ' + timeRangeOf(picked) : '');
        var lines = [
          when,
          clean(ch.name) + (category ? ' (' + category + ')' : ''),
          clean(picked.sport) && norm(picked.sport) !== norm(category) ? 'Sport : ' + clean(picked.sport) + '.' : '',
          'Le lecteur ouvre le direct de la chaine.'
        ];
        var out = {
          id: programHref(ch, picked), href: programHref(ch, picked),
          url: SITE, type: 'video',
          title: clean(picked.title) || clean(ch.name),
          description: lines.filter(Boolean).join(' '),
          status: isLiveNow(picked, at) ? 'En direct' : 'A venir'
        };
        if (logo) { out.image = logo; out.poster = logo; }
        if (clean(picked.sport) || category) out.genres = [clean(picked.sport) || category];
        return out;
      }
    }

    var liveStream = liveStreamOf(data, ch);
    var desc = ['Chaine sportive en direct sur SportingStream' + (category ? ' (rubrique ' + category + ')' : '') + '.'];
    if (live) desc.push('En direct maintenant : ' + clean(live.title) + (timeRangeOf(live) ? ' (' + timeRangeOf(live) + ')' : '') + '.');
    else if (liveStream) desc.push('En direct maintenant : ' + clean(liveStream.title) + '.');
    if (soon.length) {
      desc.push('A suivre : ' + soon.map(function (p) {
        return whenLabel(p, at) + ' ' + clean(p.title);
      }).join(' ; ') + '.');
    } else if (!live && !liveStream) {
      desc.push('Aucun programme annonce pour cette chaine.');
    }

    var details = {
      id: channelHref(ch), href: channelHref(ch), url: SITE, type: 'video',
      title: clean(ch.name),
      description: desc.join(' '),
      status: num(ch.has_url) ? 'En direct' : 'Hors antenne'
    };
    if (logo) { details.image = logo; details.poster = logo; }
    if (category) details.genres = [category];
    return details;
  }

  /* --------------------------------------------------------------- episodes */
  async function extractEpisodes(seriesId) {
    var ref = parseRef(seriesId);
    if (!ref || (!ref.id && !ref.name)) throw new Error('SportingStream : identifiant invalide.');
    var data = await publicData(now() + 15000);
    var ch = channelOf(data, ref);
    if (!ch) throw new Error('SportingStream : chaine inconnue.');
    var at = new Date();
    var programs = programsOf(data, ch);
    var live = liveProgramOf(programs, at);
    var logo = httpsUrl(ch.logo);

    var out = [{
      number: 1,
      href: channelHref(ch),
      title: (live ? 'En direct : ' : 'Direct : ') + clean(live ? live.title : ch.name)
    }];
    if (logo) out[0].image = logo;

    /* The rest of the day is a guide: each row opens the same live channel, so
     * the title carries the hour instead of pretending to be a replay. */
    var soon = upcomingOf(programs, at, 24).filter(function (p) {
      var r = rangeOf(p);
      return r.start && dayStart(r.start) === dayStart(at);
    }).slice(0, 6);
    var i;
    for (i = 0; i < soon.length; i++) {
      var entry = {
        number: i + 2,
        href: programHref(ch, soon[i]),
        title: (clean(soon[i].start) || '') + ' - ' + (clean(soon[i].title) || clean(ch.name))
      };
      if (logo) entry.image = logo;
      out.push(entry);
    }
    return out;
  }

  /* -------------------------------------------------------------- streaming */
  async function extractStreamUrl(episodeHref) {
    var ref = parseRef(episodeHref);
    if (!ref || (!ref.id && !ref.name)) throw new Error('SportingStream : identifiant invalide.');
    var deadline = now() + 15000;

    /* Resolve the channel name to its id. The cached snapshot is enough and a
     * failure there must not stop playback: the id may already be in the href. */
    var id = ref.id;
    try {
      var data = await publicData(deadline);
      var ch = channelOf(data, ref);
      if (!ch) throw new Error('SportingStream : chaine inconnue.');
      if (!num(ch.has_url)) throw new Error('SportingStream : cette chaine est hors antenne.');
      id = num(ch.id);
    } catch (e) {
      if (!id) throw e;
    }
    if (!id) throw new Error('SportingStream : identifiant invalide.');

    /* The site's own flow: a short-lived token, then the proxied playlists.
     * Nothing is cached here; a new call always asks for a fresh token. */
    var token = await fetchJson(API + '/stream-token/' + id, deadline, 6000);
    if (token.status === 429) throw new Error('SportingStream : le site limite les requetes (HTTP 429). Reessayez dans une minute.');
    var t = token.status === 200 && token.data && token.data.t ? String(token.data.t) : '';
    if (!t) throw new Error('SportingStream : aucune source disponible pour cette chaine (HTTP ' + (token.status || '?') + ').');

    var stream = await fetchJson(API + '/stream/' + id + '?t=' + encodeURIComponent(t), deadline, 8000);
    var raw = stream.status === 200 && stream.data && Array.isArray(stream.data.urls) ? stream.data.urls : [];
    var urls = [], i, u;
    for (i = 0; i < raw.length && urls.length < 3; i++) {
      u = httpsUrl(raw[i]);
      if (u && urls.indexOf(u) === -1) urls.push(u);
    }
    if (!urls.length) throw new Error('SportingStream : aucune source pour cette chaine.');

    var streams = [];
    for (i = 0; i < urls.length; i++) {
      streams.push(urls.length > 1 ? 'Source ' + (i + 1) : 'Direct');
      streams.push(urls[i]);
    }
    return {
      url: urls[0],
      type: 'hls',
      streams: streams,
      streamType: 'hls',
      isLive: true,
      provider: 'SportingStream',
      headers: STREAM_HEADERS
    };
  }

  /* -------------------------------------------------------------- discovery */
  function soonEntries(data, at, hours) {
    var out = [], i, p, ch, r;
    for (i = 0; i < data.programs.length; i++) {
      p = data.programs[i];
      ch = p ? channelByName(data, p.channel) : null;
      if (!ch) continue;
      r = rangeOf(p);
      if (!r.start || r.start <= at) continue;
      if (r.start - at > hours * 3600000) continue;
      out.push({ channel: ch, program: p });
    }
    out.sort(function (a, b) {
      return rangeOf(a.program).start.getTime() - rangeOf(b.program).start.getTime();
    });
    return out;
  }

  function liveEntries(data, at) {
    var found = [], seen = {}, i, p, ch;
    for (i = 0; i < data.programs.length; i++) {
      p = data.programs[i];
      ch = p ? channelByName(data, p.channel) : null;
      if (ch && isLiveNow(p, at)) found.push({ channel: ch, program: p });
    }
    /* The EPG often lists concurrent rows for one channel (an NBA night on
     * beIN 1). One live row per channel keeps the home row readable. */
    found.sort(function (a, b) {
      return rangeOf(a.program).start.getTime() - rangeOf(b.program).start.getTime();
    });
    var out = [];
    for (i = 0; i < found.length; i++) {
      var key = String(num(found[i].channel.id));
      if (seen[key]) continue;
      seen[key] = true;
      out.push(found[i]);
    }
    return out;
  }

  async function discoveryHome() {
    var deadline = now() + 7000;
    var data = await publicData(deadline);
    var at = new Date();
    var sections = [], i;

    var live = liveEntries(data, at);
    if (live.length) {
      sections.push({
        id: 'live',
        title: 'En direct maintenant',
        style: 'landscape',
        items: live.slice(0, 12).map(function (e) { return programCard(e.channel, e.program, at); }),
        viewAll: { mode: 'feed', feedId: 'live' }
      });
    }

    var soon = soonEntries(data, at, 24);
    if (soon.length) {
      sections.push({
        id: 'soon',
        title: 'Programmes des prochaines 24 h',
        style: 'landscape',
        items: soon.slice(0, 12).map(function (e) { return programCard(e.channel, e.program, at); }),
        viewAll: { mode: 'feed', feedId: 'soon' }
      });
    }

    /* One row per channel category the site publishes, in its own order. */
    var categories = data.categories.slice().sort(function (a, b) { return num(a.order) - num(b.order); });
    var channels = channelsSorted(data);
    for (i = 0; i < categories.length && sections.length < 8; i++) {
      var cat = clean(categories[i].name);
      if (!cat) continue;
      var row = channels.filter(function (c) { return norm(c.category) === norm(cat); });
      if (!row.length) continue;
      sections.push({
        id: 'cat-' + String(categories[i].id || i + 1),
        title: clean(categories[i].label) || cat,
        style: 'landscape',
        items: row.slice(0, 12).map(function (c) {
          return channelCard(c, at, liveProgramOf(programsOf(data, c), at));
        }),
        viewAll: { mode: 'feed', feedId: 'cat-' + String(categories[i].id || i + 1) }
      });
    }

    sections.push({
      id: 'channels',
      title: 'Toutes les chaines',
      style: 'landscape',
      items: channels.slice(0, 30).map(function (c) {
        return channelCard(c, at, liveProgramOf(programsOf(data, c), at));
      }),
      viewAll: { mode: 'feed', feedId: 'channels' }
    });

    return { sections: sections.slice(0, 10) };
  }

  async function discoveryFeed(feedId, page) {
    var deadline = now() + 9000;
    var data = await publicData(deadline);
    var at = new Date();
    var pageNum = Math.max(1, Math.floor(num(page) || 1));
    var id = String(feedId == null ? '' : feedId);
    var cards = [], i;

    if (id === 'live') {
      cards = liveEntries(data, at).map(function (e) { return programCard(e.channel, e.program, at); });
    } else if (id === 'soon') {
      cards = soonEntries(data, at, 24).map(function (e) { return programCard(e.channel, e.program, at); });
    } else if (/^cat-\d+$/.test(id)) {
      var catId = num(id.slice(4));
      var cat = null;
      for (i = 0; i < data.categories.length; i++) if (num(data.categories[i].id) === catId) cat = data.categories[i];
      if (!cat) return { items: [], page: pageNum, hasMore: false };
      var row = channelsSorted(data).filter(function (c) { return norm(c.category) === norm(cat.name); });
      cards = row.map(function (c) { return channelCard(c, at, liveProgramOf(programsOf(data, c), at)); });
    } else {
      cards = channelsSorted(data).map(function (c) {
        return channelCard(c, at, liveProgramOf(programsOf(data, c), at));
      });
    }

    var size = 24;
    var startAt = (pageNum - 1) * size;
    return {
      items: cards.slice(startAt, startAt + size),
      page: pageNum,
      hasMore: startAt + size < cards.length
    };
  }

  /* ------------------------------------------------ optional live match data */
  /* No licensed statistics provider is involved, so no liveEvent is exposed and
   * extractLiveEvent is deliberately absent. */

  globalThis.liveHome = liveHome;
  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
})();
