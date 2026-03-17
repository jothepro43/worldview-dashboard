@echo off
echo ========================================
echo  WorldView - Push Changes to GitHub
echo ========================================

echo 1. Checking Git Status...
git status
if %errorlevel% neq 0 (
    echo Error: Git not found or repository issue.
    pause
    exit /b
)

echo.
echo 2. Creating Branch v2-enhanced-proxy...
git checkout -b v2-enhanced-proxy
if %errorlevel% neq 0 (
    echo Branch might already exist, switching to it...
    git checkout v2-enhanced-proxy
)

echo.
echo 3. Staging Changes...
git add .

echo.
echo 4. Committing Changes...
git commit -m "feat: Enhance proxy auth, expand camera feeds, and fix UI layout"

echo.
echo 5. Pushing to GitHub...
git push -u origin v2-enhanced-proxy

echo.
echo ========================================
echo  Success! Changes pushed to v2-enhanced-proxy
echo ========================================
pause