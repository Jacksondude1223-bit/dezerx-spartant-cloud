<?php

$envPath = $argv[1] ?? null;

if ($envPath === null || ! is_file($envPath)) {
    fwrite(STDERR, "usage: sync-env.php <env-file> [key-file ...] [--default KEY=VALUE ...]\n");
    exit(1);
}

$keySources = [$envPath];
$defaults = [];

for ($i = 2; $i < $argc; $i++) {
    if ($argv[$i] === '--default' && isset($argv[$i + 1])) {
        [$key, $value] = array_pad(explode('=', $argv[++$i], 2), 2, '');
        $defaults[$key] = $value;

        continue;
    }

    $keySources[] = $argv[$i];
}

function envKeys(string $path): array
{
    $contents = is_readable($path) ? (string) file_get_contents($path) : '';
    preg_match_all('/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/m', $contents, $matches);

    return $matches[1];
}

function formatEnvValue(string $value): string
{
    if ($value === '' || preg_match('/^[A-Za-z0-9_.:\/@+,=-]+$/', $value)) {
        return $value;
    }

    return '"'.strtr($value, ['\\' => '\\\\', '"' => '\\"', '$' => '\\$', "\n" => '\\n', "\r" => '\\r']).'"';
}

function setEnvValue(string $contents, string $key, string $value): string
{
    $line = $key.'='.formatEnvValue($value);
    $pattern = '/^[ \t]*(?:export[ \t]+)?'.preg_quote($key, '/').'[ \t]*=.*$/m';

    if (preg_match($pattern, $contents)) {
        return preg_replace_callback($pattern, static fn () => $line, $contents);
    }

    return rtrim($contents, "\n")."\n".$line."\n";
}

$original = (string) file_get_contents($envPath);
$contents = $original;

foreach ($defaults as $key => $value) {
    $contents = setEnvValue($contents, $key, $value);
}

foreach (array_unique(array_merge(['PRODUCT_ID'], ...array_map('envKeys', $keySources))) as $key) {
    $value = getenv($key);

    if ($value !== false && $value !== '') {
        $contents = setEnvValue($contents, $key, $value);
    }
}

if ($contents !== $original && file_put_contents($envPath, $contents) === false) {
    fwrite(STDERR, "Unable to write {$envPath}\n");
    exit(1);
}
