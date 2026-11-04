#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* Stdin-only, foreground-only input in the existing Wine desktop. No game
 * process handles, memory access, hooks, account data or network interface. */
static DWORD owner_pid;
static HWND game;
static BOOL firing;
static unsigned long held_keys;
static const WORD keys[]={0x57,0x41,0x53,0x44,0x45,0x51,0x52,0x46,0x56,VK_SHIFT,VK_SPACE,VK_ESCAPE,VK_RETURN,VK_TAB,0x31,0x32,0x33,0x34,0x48,0x42};
static BOOL keyboard(WORD vk,BOOL down){INPUT i={0};i.type=INPUT_KEYBOARD;i.ki.wVk=vk;i.ki.wScan=(WORD)MapVirtualKeyW(vk,MAPVK_VK_TO_VSC);i.ki.dwFlags=down?0:KEYEVENTF_KEYUP;
 /* Wine delivers gameplay movement through raw input, while this game menu
  * consumes Escape window messages. The focused HWND is pinned at startup. */
 if(vk==VK_ESCAPE)return PostMessageW(game,down?WM_KEYDOWN:WM_KEYUP,vk,1|((LPARAM)i.ki.wScan<<16)|(down?0:((LPARAM)3<<30)));
 return SendInput(1,&i,sizeof i)==1;}
static const WCHAR *stop_path,*abort_path;
static BOOL emit(const char *s){DWORD n=0;return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),s,(DWORD)strlen(s),&n,NULL)&&n==strlen(s);}
static void error(const char *s){char out[256];snprintf(out,sizeof out,"{\"ok\":false,\"error\":\"%s\"}\n",s);emit(out);}
static BOOL mouse(DWORD flags,LONG x,LONG y){INPUT i={0};i.type=INPUT_MOUSE;i.mi.dwFlags=flags;i.mi.dx=x;i.mi.dy=y;return SendInput(1,&i,sizeof i)==1;}
static BOOL release(void){BOOL ok=TRUE;if(firing)ok=mouse(MOUSEEVENTF_LEFTUP,0,0);firing=FALSE;for(unsigned int k=0;k<sizeof keys/sizeof keys[0];k++)if(held_keys&(1UL<<k))if(!keyboard(keys[k],FALSE))ok=FALSE;held_keys=0;return ok;}
static BOOL present(const WCHAR *p){DWORD v=GetFileAttributesW(p);if(v!=INVALID_FILE_ATTRIBUTES)return TRUE;DWORD e=GetLastError();return e!=ERROR_FILE_NOT_FOUND&&e!=ERROR_PATH_NOT_FOUND;}
static BOOL focused(void){HWND current=GetForegroundWindow();DWORD pid=0;GetWindowThreadProcessId(current,&pid);return current==game&&pid==owner_pid;}
static const char *guard_reason(void){if(!focused())return "Windows game focus changed";if(present(stop_path))return "Owner STOP file is present";if(present(abort_path))return "Native input watch aborted";return NULL;}
static BOOL allowed(void){return guard_reason()==NULL;}
static BOOL control(long dx,long dy,long ms,int fire,unsigned long mask){
 if(labs(dx)>400||labs(dy)>250||ms<20||ms>3000||(fire!=0&&fire!=1)||mask>=(1UL<<20)){error("Invalid bounded controls");return TRUE;}
 if(mask&(1UL<<11)){error("Escape requires one-shot menu command");return TRUE;}
 const char *initial=guard_reason();if(initial){error(initial);return TRUE;}
 ULONGLONG start=GetTickCount64();const char *failure=NULL;
 for(unsigned int k=0;k<sizeof keys/sizeof keys[0];k++)if(mask&(1UL<<k)){if(!keyboard(keys[k],TRUE)){failure="Keyboard input refused";goto done;}held_keys|=1UL<<k;}
 if((dx||dy)&&!mouse(MOUSEEVENTF_MOVE|MOUSEEVENTF_MOVE_NOCOALESCE,(LONG)dx,(LONG)dy)){failure="Relative mouse input refused";goto done;}
 if(fire){Sleep(20);if(!allowed()){failure=guard_reason();goto done;}if(!mouse(MOUSEEVENTF_LEFTDOWN,0,0)){failure="Fire input refused";goto done;}firing=TRUE;}
 while(GetTickCount64()-start<(ULONGLONG)ms){if(!allowed()){failure=guard_reason();break;}Sleep(25);}
 done:
 if(!release()&&!failure)failure="Input release refused";
 if(failure){error(failure);return TRUE;}
 char out[160];snprintf(out,sizeof out,"{\"ok\":true,\"controlledMs\":%ld,\"winPid\":%lu,\"keyMask\":%lu}\n",ms,(unsigned long)owner_pid,mask);return emit(out);
}
static DWORD WINAPI input_loop(LPVOID unused){
 (void)unused;
 char line[512];while(fgets(line,sizeof line,stdin)){
  if(!strchr(line,'\n')){error("Command too long");break;}
  if(strcmp(line,"release\n")==0){release();if(!emit("{\"ok\":true,\"released\":true}\n"))break;continue;}
  long dx=0,dy=0,ms=0;int fire=0;unsigned long mask=0;char extra=0;
  if(sscanf(line,"control %ld %ld %ld %d %lu %c",&dx,&dy,&ms,&fire,&mask,&extra)!=5){error("Invalid input command");continue;}
  if(!control(dx,dy,ms,fire,mask))break;
 }
 release();return 0;
}
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE previous,PWSTR command,int show){
 (void)instance;(void)previous;(void)command;(void)show;
 int argc=0;LPWSTR *argv=CommandLineToArgvW(GetCommandLineW(),&argc);
 if(!argv||(argc!=3&&argc!=5)){error("Stop and abort paths required");return 2;}
 stop_path=argv[1];abort_path=argv[2];game=GetForegroundWindow();WCHAR title[256]={0};GetWindowTextW(game,title,256);
 size_t len=wcslen(title);while(len&&title[len-1]==L' ')title[--len]=0;
 if(wcscmp(title,L"Marvel Rivals")!=0){error("Exact foreground game window missing");LocalFree(argv);return 3;}
 GetWindowThreadProcessId(game,&owner_pid);if(!owner_pid){error("Game process identity missing");LocalFree(argv);return 4;}
 /* One-shot Escape mirrors the separately verified GUI probe. In this Wine
  * build, the persistent stdin command path does not reliably open the menu. */
 if(argc==5){
  WCHAR *end=NULL;long ms=wcstol(argv[4],&end,10);
  if(wcscmp(argv[3],L"escape")||!end||*end||ms<20||ms>3000){error("Invalid one-shot menu command");LocalFree(argv);return 6;}
  const char *failure=guard_reason();if(failure){error(failure);LocalFree(argv);return 7;}
  WORD scan=(WORD)MapVirtualKeyW(VK_ESCAPE,MAPVK_VK_TO_VSC);
  BOOL down=PostMessageW(game,WM_KEYDOWN,VK_ESCAPE,1|((LPARAM)scan<<16));
  ULONGLONG start=GetTickCount64();
  while(down&&GetTickCount64()-start<(ULONGLONG)ms){failure=guard_reason();if(failure)break;Sleep(25);}
  BOOL up=PostMessageW(game,WM_KEYUP,VK_ESCAPE,1|((LPARAM)scan<<16)|((LPARAM)3<<30));
  if(!down||!up||failure){error(failure?failure:"Menu key refused");LocalFree(argv);return 8;}
  emit("{\"ok\":true,\"menuKey\":\"escape\"}\n");LocalFree(argv);return 0;
 }
 char out[128];snprintf(out,sizeof out,"{\"ready\":true,\"winPid\":%lu}\n",(unsigned long)owner_pid);if(!emit(out)){LocalFree(argv);return 5;}
 HANDLE worker=CreateThread(NULL,0,input_loop,NULL,0,NULL);
 if(!worker){error("Input thread unavailable");LocalFree(argv);return 9;}
 for(;;){
  DWORD state=MsgWaitForMultipleObjects(1,&worker,FALSE,INFINITE,QS_ALLINPUT);
  if(state==WAIT_OBJECT_0)break;
  if(state==WAIT_FAILED){WaitForSingleObject(worker,INFINITE);break;}
  MSG message;while(PeekMessageW(&message,NULL,0,0,PM_REMOVE)){TranslateMessage(&message);DispatchMessageW(&message);}
 }
 CloseHandle(worker);
 release();LocalFree(argv);return 0;
}
