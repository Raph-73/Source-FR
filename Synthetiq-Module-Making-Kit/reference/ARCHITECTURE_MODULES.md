# Synthetiq Player - Per-Screen Dynamic Module Switching Architecture

## Overview

This document describes the architecture that enables **per-screen module context** in Synthetiq Player, allowing different screens to use different content modules simultaneously without changing the global active module state.

## Problem Solved

### Before (Global Module State)
- Only one module could be active at a time globally
- Switching modules required changing `ModuleState.activeModule`
- Favorites from different modules caused conflicts
- Navigation between series from different modules was broken

### After (Per-Screen Module Context)
- Each screen uses its own module context via `expectedModuleId`
- No global module switching required
- Cross-module favorites work seamlessly
- Users can browse series from Module A while Module B is globally active

## Architecture Components

### 1. Module State Layer (`lib/services/module_state.dart`)

The `ModuleState` class provides **WithModule variants** for all data-fetching operations:

```dart
// Global operations (use active module)
Future<AnimeSeries?> fetchSeriesDetails(String seriesId)
Future<List<Episode>> fetchEpisodes(String seriesId)
Future<StreamSource> fetchStreamUrl(String episodeId, {StreamLanguage lang})

// Per-module operations (use specified module)
Future<AnimeSeries?> fetchSeriesDetailsWithModule(String seriesId, String moduleId)
Future<List<Episode>> fetchEpisodesWithModule(String seriesId, String moduleId)
Future<StreamSource> fetchStreamUrlWithModule(String episodeId, String moduleId, {StreamLanguage lang})
```

**Key Implementation:**
```dart
Future<List<Episode>> fetchEpisodesWithModule(String seriesId, String? moduleId) async {
  final module = _getModuleOrActive(moduleId);
  if (module == null) return const [];
  
  return module.type == ModuleType.client
      ? await _clientRuntime.fetchEpisodes(module, seriesId)  // JS module
      : await _client.fetchEpisodes(module, seriesId);         // Server module
}

ModuleConfig? _getModuleOrActive(String? moduleId) {
  if (moduleId == null) return hasActiveModule ? _activeModule : null;
  return _modules.firstWhere(
    (m) => m.id == moduleId,
    orElse: () => hasActiveModule ? _activeModule : _placeholderModule,
  );
}
```

### 2. JS Runtime Management (`lib/services/client_module_runtime.dart`)

Tracks which module's JS code is loaded and resets when switching:

```dart
class ClientModuleRuntime {
  final Set<String> _loadedModules = {};
  String? _currentJsModuleId; // Tracks which module's code is in runtime
  
  Future<void> _ensureModuleLoaded(ModuleConfig module) async {
    // If different module loaded, reset JS runtime first
    if (_currentJsModuleId != null && _currentJsModuleId != module.id) {
      debugPrint('[MODULE] Different module loaded ($_currentJsModuleId), resetting for ${module.id}');
      resetForModuleSwitch();
    }
    
    if (_loadedModules.contains(module.id)) {
      return; // Already loaded
    }
    
    // Load and execute module JS code
    await _jsService.loadModuleCode(script);
    _loadedModules.add(module.id);
    _currentJsModuleId = module.id;
  }
  
  void resetForModuleSwitch() {
    _loadedModules.clear();
    _currentJsModuleId = null;
    _jsService.resetRuntime();
  }
}
```

### 3. Screen-Level Module Context

#### Series Detail Screen (`lib/screens/series/series_detail_screen.dart`)

Accepts `expectedModuleId` to determine which module to use:

```dart
class SeriesDetailScreen extends StatefulWidget {
  final String seriesId;
  final AnimeSeries? initialSeries;
  final String? expectedModuleId;  // <-- Per-screen module context
  
  const SeriesDetailScreen({
    required this.seriesId,
    this.initialSeries,
    this.expectedModuleId,
  });
}

class _SeriesDetailScreenState extends State<SeriesDetailScreen> {
  Future<_SeriesDetailData> _load(ModuleState moduleState) async {
    // Use expectedModuleId if provided, otherwise use global active module
    if (widget.expectedModuleId != null) {
      series = await moduleState.fetchSeriesDetailsWithModule(
        widget.seriesId, 
        widget.expectedModuleId!
      );
    } else {
      series = await moduleState.fetchSeriesDetails(widget.seriesId);
    }
    
    episodes = await moduleState.fetchEpisodesWithModule(
      widget.seriesId, 
      widget.expectedModuleId
    );
  }
}
```

#### Watch Screen

Uses `moduleIdOverride` for stream URL fetching:

```dart
class WatchScreen extends StatefulWidget {
  final String? moduleIdOverride;  // <-- Module for stream resolution
  
  Future<StreamSource> _resolveStream() async {
    if (widget.moduleIdOverride != null) {
      return moduleState.fetchStreamUrlWithModule(
        episodeId,
        widget.moduleIdOverride!,
        lang: widget.lang,
      );
    }
    return moduleState.fetchStreamUrl(episodeId, lang: widget.lang);
  }
}
```

### 4. Navigation Layer (`lib/router.dart`)

Routes extract `moduleId` from navigation extra data and pass to screens:

```dart
GoRoute(
  path: '/series/:id',
  builder: (context, goState) {
    final extra = goState.extra as Map<String, dynamic>? ?? {};
    final moduleId = extra['moduleId'] as String?;
    
    return SeriesDetailScreen(
      seriesId: id,
      expectedModuleId: moduleId,  // Pass to screen
    );
  },
),
```

### 5. Cross-Module Favorites (`lib/screens/favourites/favourites_screen.dart`)

Detects module from series ID patterns and passes to navigation:

```dart
String? _detectModuleFromSeriesId(String seriesId, String? entryModuleId) {
  if (entryModuleId != null) return entryModuleId;
  if (seriesId.contains('1movies')) return '1movies';
  if (!seriesId.startsWith('http')) return 'custom-hianime';
  return null;
}

void _onFavouriteTap(FavouriteEntry entry, AnimeSeries series) {
  final detectedModuleId = _detectModuleFromSeriesId(entry.id, entry.moduleId);
  
  context.push('/series/${encodeRouteParam(series.id)}?from=favourites',
    extra: {
      'series': series,
      'moduleId': detectedModuleId,  // Pass detected module
    });
}
```

## Data Flow

### Cross-Module Favorite Flow

```
User taps favorite from Module A
        │
        ▼
FavouritesScreen._detectModuleFromSeriesId()
        │
        ▼
context.push('/series/:id', extra: {moduleId: 'module-a'})
        │
        ▼
Router extracts moduleId → SeriesDetailScreen(expectedModuleId: 'module-a')
        │
        ▼
SeriesDetailScreen._load() calls fetchEpisodesWithModule(seriesId, 'module-a')
        │
        ▼
ClientModuleRuntime._ensureModuleLoaded(moduleA) 
  - Detects different module → resets JS runtime
  - Loads Module A's JS code
        │
        ▼
Episodes display from Module A (global active module unchanged!)
```

## Module Types

### 1. JS-Based Client Modules
- Execute in JavaScript runtime via `flutter_js`
- Functions: `searchResults()`, `extractDetails()`, `extractEpisodes()`, `extractStreamUrl()`
- Examples: 1Movies module, custom community modules

### 2. Native Client Modules
- Dart-native implementations for built-in modules
- `HiAnimeClient` and `FireAnimeClient`
- No JS runtime needed

### 3. Server Modules
- HTTP API-based modules
- Uses standard REST endpoints

## Store Build Safety

Dev modules are excluded from production builds:

```yaml
# pubspec.yaml
flutter:
  assets:
    - assets/branding/synthetiq_logo.png
    - assets/demo/
    # Dev modules excluded for store builds:
    # - dev_assets/modules/1movies/1movies.json
    # - dev_assets/modules/1movies/1movies.js
```

```dart
// lib/config/build_flags.dart
class BuildFlags {
  static const bool isStoreBuild = bool.fromEnvironment('STORE_BUILD', defaultValue: true);
}

// In client_module_runtime.dart - asset loading
if (!BuildFlags.isStoreBuild && (script == null || script.isEmpty)) {
  try {
    final assetScript = await rootBundle.loadString(moduleScriptAssetPath(module.id));
    script = assetScript;
  } catch (_) {}
}
```

## Key Benefits

1. **No Global State Pollution**: Screens use their own module without affecting others
2. **Cross-Module Favorites**: Works seamlessly across different content sources
3. **JS Runtime Isolation**: Prevents function name collisions between modules
4. **Navigation Persistence**: Tab highlighting preserved via query parameters (`?from=favourites`)
5. **Backward Compatible**: Existing code using global active module continues to work

## File Reference

| File | Purpose |
|------|---------|
| `lib/services/module_state.dart` | Core module management with WithModule variants |
| `lib/services/client_module_runtime.dart` | JS runtime with module tracking and reset |
| `lib/services/js_service.dart` | JavaScript execution environment |
| `lib/screens/series/series_detail_screen.dart` | Series detail with per-module loading |
| `lib/screens/favourites/favourites_screen.dart` | Cross-module favorites with auto-detection |
| `lib/screens/watch/watch_screen.dart` | Video player with module override |
| `lib/router.dart` | Route configuration with moduleId extraction |
| `lib/models/module.dart` | Module configuration models |

## Version History

- **v4.5.3**: Per-screen module switching fully implemented and tested
- **v4.5.2**: Added JS runtime reset for module switching
- **v4.5.1**: Initial WithModule function variants
- **v4.5.0**: Foundation for cross-module favorites
