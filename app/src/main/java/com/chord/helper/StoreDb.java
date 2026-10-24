package com.chord.helper;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * 自建内容的本地存储（SQLite，用的是 Android 框架自带的 SQLiteOpenHelper，不引入任何依赖）。
 *
 * 表结构：
 *   items(kind, id, json, updated_at)   —— 自建的和弦走向/节奏型、以及鼓机格子的改动
 *        kind: 'progression' | 'rhythm' | 'drums'
 *        json: 该条内容的完整定义（走向的和弦列表、节奏型的格子序列…）
 *   settings(k, v)                      —— 少量偏好：当前选中的走向/节奏型/鼓机节奏、BPM、音量…
 *
 * 为什么 json 存成一段文本而不是把和弦拆成表：这些数据整体读写、整体替换，
 * 拆表只会让增删改都要跨表同步；而 kind/id/updated_at 仍是真正可查询的列，
 * 需要时可以直接在 sqlite3 里按 kind 查。真要做统计（比如“最常用的走向”），
 * 再给 items 加索引字段即可。
 */
public class StoreDb extends SQLiteOpenHelper {

    private static final String TAG = "ChordHelper";
    private static final String DB_NAME = "chord.db";
    private static final int DB_VERSION = 1;

    public StoreDb(Context ctx) {
        super(ctx, DB_NAME, null, DB_VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE items ("
                + "kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER,"
                + "PRIMARY KEY (kind, id))");
        db.execSQL("CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        /* 目前只有 v1；将来加字段时在这里做迁移，尽量保住用户数据 */
        Log.i(TAG, "store upgrade " + oldVersion + " -> " + newVersion);
    }

    public void putItem(String kind, String id, String json) {
        ContentValues cv = new ContentValues();
        cv.put("kind", kind);
        cv.put("id", id);
        cv.put("json", json);
        cv.put("updated_at", System.currentTimeMillis());
        getWritableDatabase().insertWithOnConflict("items", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
    }

    public void removeItem(String kind, String id) {
        getWritableDatabase().delete("items", "kind = ? AND id = ?", new String[]{kind, id});
    }

    /** 一次把所有内容读成 JSON：{ "progression": {id: obj}, "rhythm": {...}, "drums": {...} } */
    public String loadAllJson() {
        JSONObject root = new JSONObject();
        Cursor c = null;
        try {
            c = getReadableDatabase().rawQuery("SELECT kind, id, json FROM items", null);
            while (c.moveToNext()) {
                String kind = c.getString(0);
                String id = c.getString(1);
                String json = c.getString(2);
                JSONObject bucket = root.optJSONObject(kind);
                if (bucket == null) {
                    bucket = new JSONObject();
                    root.put(kind, bucket);
                }
                try {
                    bucket.put(id, new JSONObject(json));
                } catch (JSONException e) {
                    Log.w(TAG, "跳过一条损坏的记录 " + kind + "/" + id);
                }
            }
        } catch (JSONException e) {
            Log.w(TAG, "组装存储结果失败", e);
        } finally {
            if (c != null) c.close();
        }
        return root.toString();
    }

    public void setSetting(String k, String v) {
        ContentValues cv = new ContentValues();
        cv.put("k", k);
        cv.put("v", v);
        getWritableDatabase().insertWithOnConflict("settings", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
    }

    public String getSetting(String k, String def) {
        Cursor c = null;
        try {
            c = getReadableDatabase().query("settings", new String[]{"v"}, "k = ?", new String[]{k}, null, null, null);
            if (c.moveToFirst()) return c.getString(0);
        } finally {
            if (c != null) c.close();
        }
        return def;
    }

    /** 日志里打一行统计，方便确认"到底存进去没有" */
    public String info() {
        Cursor c = null;
        StringBuilder sb = new StringBuilder();
        try {
            c = getReadableDatabase().rawQuery("SELECT kind, COUNT(*) FROM items GROUP BY kind", null);
            while (c.moveToNext()) {
                if (sb.length() > 0) sb.append(", ");
                sb.append(c.getString(0)).append('=').append(c.getInt(1));
            }
        } finally {
            if (c != null) c.close();
        }
        return "chord.db{" + (sb.length() == 0 ? "空" : sb.toString()) + "}";
    }

    /**
     * 暴露给网页的桥：window.NativeStore
     * 注意 addJavascriptInterface 的方法是在 JavaBridge 线程上调用的，不在主线程，
     * 所以这里直接访问数据库是安全的（不会卡 UI）。
     */
    public static class Bridge {
        private final StoreDb db;

        public Bridge(StoreDb db) {
            this.db = db;
        }

        @JavascriptInterface
        public String loadAll() {
            return db.loadAllJson();
        }

        @JavascriptInterface
        public void putItem(String kind, String id, String json) {
            db.putItem(kind, id, json);
        }

        @JavascriptInterface
        public void removeItem(String kind, String id) {
            db.removeItem(kind, id);
        }

        @JavascriptInterface
        public void setSetting(String k, String v) {
            db.setSetting(k, v);
        }

        @JavascriptInterface
        public String getSetting(String k, String def) {
            return db.getSetting(k, def);
        }

        @JavascriptInterface
        public String info() {
            return db.info();
        }
    }
}
