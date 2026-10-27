# Manga/Novel Integration Guide

## What Was Built

### New Models
- `lib/models/app_mode.dart` - Video vs Image mode enum
- `lib/models/manga_series.dart` - Manga series and chapter models
- Updated `lib/models/module.dart` - Added ContentType (video/image/text)

### New Services
- `lib/services/app_mode_state.dart` - Tracks current app mode
- `lib/services/image_client_runtime.dart` - JS runtime for image modules

### New UI Components
- `lib/widgets/mode_toggle.dart` - Liquid glass pill toggle
- `lib/screens/reader/manga_reader_screen.dart` - Full manga reader
- `lib/screens/reader/novel_reader_screen.dart` - Full novel reader

## How to Integrate

### 1. Update HomeScreen

Add to imports:
```dart
import '../../models/app_mode.dart';
import '../../services/app_mode_state.dart';
import '../../widgets/mode_toggle.dart';
```

Wrap with providers:
```dart
@override
Widget build(BuildContext context) {
  return ChangeNotifierProvider(
    create: (_) => AppModeState(),
    child: Consumer<AppModeState>(
      builder: (context, modeState, child) {
        return Scaffold(
          // ...
          body: Column(
            children: [
              // Add mode toggle at top
              Padding(
                padding: const EdgeInsets.all(8.0),
                child: Center(
                  child: ModeToggle(
                    currentMode: modeState.currentMode,
                    onModeChanged: modeState.setMode,
                  ),
                ),
              ),
              // Show content based on mode
              Expanded(
                child: modeState.isVideoMode
                    ? _buildVideoHome()
                    : _buildImageHome(),
              ),
            ],
          ),
        );
      },
    ),
  );
}
```

### 2. Module Content Type

Modules now have a `contentType` field:
```dart
// Video module (default)
ModuleConfig(
  id: 'hianime',
  contentType: ContentType.video, // or omitted (default)
)

// Manga module
ModuleConfig(
  id: 'mangadex',
  contentType: ContentType.image,
)

// Novel module
ModuleConfig(
  id: 'novelbin',
  contentType: ContentType.text,
)
```

### 3. Continue Watching vs Continue Reading

Show different continue sections based on mode:
```dart
Widget _buildContinueSection(AppModeState modeState) {
  if (modeState.isVideoMode) {
    return ContinueWatchingSection(
      history: watchHistory.items.where((h) => h.isVideo).toList(),
    );
  } else {
    return ContinueReadingSection(
      history: watchHistory.items.where((h) => h.isImage).toList(),
    );
  }
}
```

## Supported Modules

### Manga (Image-based)
- ✅ MangaDex
- ✅ MangaBuddy
- ✅ MangaFire
- ✅ MangaFreak
- ✅ MangaKatana
- ✅ MangaPark
- ✅ WeebCentral

### Novels (Text-based)
- ✅ NovelBin
- ✅ NovelCool
- ✅ NovelNext
- ✅ ReadNovelFull
- ✅ ReadNovels
- ✅ ChiReads
- ✅ HelioScans

## Module Functions

### Video Modules (existing)
```javascript
async function searchResults(query)
async function extractDetails(url)
async function extractEpisodes(url)
async function extractStreamUrl(episodeUrl)
```

### Manga Modules (new)
```javascript
async function searchResults(keyword, page=0)
async function extractDetails(ID)
async function extractChapters(url)
async function extractImages(chapterId)  // Returns array of image URLs
```

### Novel Modules (new)
```javascript
async function searchResults(keyword, page=0)
async function extractDetails(url)
async function extractChapters(url)
async function extractText(url)  // Returns chapter text content
```

## Reader Features

### Manga Reader
- ✅ Page mode (swipe/click)
- ✅ Scroll mode (continuous)
- ✅ Zoom (pinch/double-tap)
- ✅ Tap zones (left/right/center)
- ✅ Navigation buttons
- ✅ Chapter navigation (prev/next)
- ✅ Page counter
- ✅ Preload next images

### Novel Reader
- ✅ Scroll reading
- ✅ Font size adjustment
- ✅ Line spacing control
- ✅ Day/Night mode
- ✅ Progress tracking
- ✅ Chapter navigation
- ✅ Selectable text

## Next Steps

1. Integrate AppModeState into main app
2. Create MangaGridView widget for image mode
3. Update search to filter by content type
4. Add ContinueReadingSection widget
5. Test with real manga modules
6. Add reading history for image content
